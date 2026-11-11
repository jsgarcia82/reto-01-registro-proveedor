import cookie from "@fastify/cookie"
import rateLimit from "@fastify/rate-limit"
import fastifyStatic from "@fastify/static"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { type AgentDeps, ejecutarTurno, historial, registrarEvento } from "./agent/loop.js"
import { type AppConfig, loadConfig } from "./config.js"
import { createDb, type Db } from "./db/db.js"
import { type Clock, DomainError, sha256, systemClock } from "./domain/core.js"
import { cargarMaestro, listarCasos, type Paths, verificarChecksums } from "./domain/fixtures.js"
import { valoresSensibles } from "./domain/privacy.js"
import { safeJoin } from "./docs/files.js"
import type { LlmAdapter } from "./llm/adapter.js"
import { AnthropicAdapter } from "./llm/anthropic.js"
import { MockLlm } from "./llm/mock.js"
import { PrivacyGuardAdapter } from "./llm/privacy-guard.js"
import { confirmarEnvio } from "./services/confirmations.js"
import type { Services } from "./services/context.js"
import { autenticar, cerrarSesionAuth, crearSesionAuth, crearSesionChat, parseDemoUsers, upsertUsuario, type Usuario, usuarioPorToken } from "./services/users.js"

export interface AppOptions {
  directory: string
  config: AppConfig
  db: Db
  clock?: Clock
  llm?: LlmAdapter
  paths?: Paths
  logger?: boolean
}

declare module "fastify" {
  interface FastifyRequest {
    usuario: Usuario | null
  }
}

const COOKIE = "sid"
const ChatBody = z.object({ sessionId: z.string().uuid(), message: z.string().trim().min(1).max(4000) })
const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })
const ConfirmBody = z.object({ token: z.string().min(20).max(200) })
const IdParam = z.object({ id: z.string().uuid() })
const MIME: Record<string, string> = { ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".txt": "text/plain; charset=utf-8", ".jsonl": "text/plain; charset=utf-8" }

export async function crearLlm(config: AppConfig, casos: string[]): Promise<LlmAdapter> {
  if (config.llmProvider === "anthropic") {
    if (!config.anthropicApiKey) throw new Error("LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY")
    return AnthropicAdapter.fromEnv(config.anthropicApiKey, config.anthropicModel, config.llmTimeoutMs)
  }
  return new MockLlm(casos)
}

export async function construirApp(o: AppOptions): Promise<{ app: FastifyInstance; services: Services; deps: AgentDeps }> {
  const paths: Paths = o.paths ?? { fixtures: join(o.directory, "fixtures", "reto-01"), out: join(o.directory, "out") }
  const services: Services = { db: o.db, clock: o.clock ?? systemClock(o.config.asOfDate, o.config.businessTimezone), paths, config: { confirmationTtlSeconds: o.config.confirmationTtlSeconds } }
  const base = o.llm ?? (await crearLlm(o.config, await listarCasos(paths)))
  const llm = new PrivacyGuardAdapter(base, valoresSensibles(await cargarMaestro(paths)))
  const deps: AgentDeps = { services, llm, directory: o.directory, maxIterations: o.config.maxIterationsPerTurn, maxTokensPerSession: o.config.maxTokensPerSession }

  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 64 * 1024, trustProxy: o.config.trustProxy })
  await app.register(cookie)
  // Límite de tasa por IP (protege la clave del LLM y el login frente a fuerza bruta).
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" })
  app.decorateRequest("usuario", null)

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) return reply.code(400).send({ ok: false, error: err.message })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.code(status).send({ ok: false, error: "Petición inválida." })
    app.log.error(err)
    return reply.code(500).send({ ok: false, error: "Error interno; quedó registrado." })
  })

  // Autenticación: toda ruta /api salvo login y health exige sesión válida.
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/login") || req.url.startsWith("/api/health")) return
    const token = req.cookies[COOKIE]
    req.usuario = token ? await usuarioPorToken(o.db, token, services.clock.now()) : null
    if (!req.usuario) return reply.code(401).send({ ok: false, error: "No autenticado." })
  })
  const user = (req: FastifyRequest): Usuario => {
    if (!req.usuario) throw new DomainError("No autenticado.", "auth")
    return req.usuario
  }

  // Sin límite de tasa: lo consulta el health check de la plataforma cada pocos segundos.
  app.get("/api/health", { config: { rateLimit: false } }, async () => ({ ok: true, provider: llm.provider, model: llm.model }))

  app.post("/api/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = LoginBody.safeParse(req.body)
    if (!b.success) return reply.code(400).send({ ok: false, error: "Correo o clave con formato inválido." })
    const u = await autenticar(o.db, b.data.email, b.data.password)
    if (!u) return reply.code(401).send({ ok: false, error: "Credenciales inválidas." })
    const token = await crearSesionAuth(o.db, u.id, services.clock.now())
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: o.config.cookieSecure, path: "/", maxAge: 8 * 3600 })
    return { ok: true, email: u.email }
  })

  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[COOKIE]
    if (token) await cerrarSesionAuth(o.db, token)
    reply.clearCookie(COOKIE, { path: "/" })
    return { ok: true }
  })

  app.get("/api/me", async (req) => ({ ok: true, email: user(req).email, casos: await listarCasos(paths), fechaReferencia: services.clock.today() }))

  app.post("/api/sessions", async (req) => ({ ok: true, sessionId: await crearSesionChat(o.db, user(req).id) }))

  app.get("/api/sessions", async (req) => {
    const r = await o.db.query("SELECT id, created_at FROM chat_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", [user(req).id])
    return { ok: true, sesiones: r.rows }
  })

  // Sesiones privadas: una sesión ajena responde 404 (no revela su existencia).
  app.get("/api/sessions/:id", async (req, reply) => {
    const p = IdParam.safeParse(req.params)
    if (!p.success) return reply.code(404).send({ ok: false, error: "Sesión no encontrada." })
    const r = await o.db.query("SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2", [p.data.id, user(req).id])
    if (!r.rows[0]) return reply.code(404).send({ ok: false, error: "Sesión no encontrada." })
    return { ok: true, sessionId: p.data.id, mensajes: await historial(services, p.data.id) }
  })

  app.post("/api/chat", async (req, reply) => {
    const b = ChatBody.safeParse(req.body)
    if (!b.success) return reply.code(400).send({ ok: false, error: "Se requiere sessionId (uuid) y message (1-4000 caracteres)." })
    try {
      const r = await ejecutarTurno(deps, { sessionId: b.data.sessionId, userId: user(req).id, message: b.data.message })
      return { ok: true, ...r }
    } catch (err) {
      if (err instanceof DomainError && err.code === "no_encontrada") return reply.code(404).send({ ok: false, error: err.message })
      if (err instanceof DomainError && err.code === "sesion_ocupada") return reply.code(409).send({ ok: false, error: err.message })
      throw err
    }
  })

  // HITL: única vía para ejecutar el envío. El token llega del front (decisión humana), nunca del modelo.
  app.post("/api/confirmaciones", async (req, reply) => {
    const b = ConfirmBody.safeParse(req.body)
    if (!b.success) return reply.code(400).send({ ok: false, error: "Token de confirmación inválido." })
    const u = user(req)
    try {
      const r = await confirmarEnvio(services, { token: b.data.token, userId: u.id, userEmail: u.email })
      const ses = await o.db.query<{ session_id: string }>("SELECT session_id FROM confirmations WHERE token_hash = $1", [sha256(b.data.token)])
      const sid = ses.rows[0]?.session_id
      if (sid) await registrarEvento(services, sid, u.id, `Envío simulado ${r.repetido ? "ya existía (idempotente)" : "confirmado"} por ${u.email}: ${r.ruta}`)
      return { ok: true, ...r }
    } catch (err) {
      if (err instanceof DomainError) return reply.code(409).send({ ok: false, error: err.message })
      throw err
    }
  })

  app.get("/api/alertas", async (req) => {
    const r = await o.db.query("SELECT severidad, codigo, mensaje, ts FROM alerts WHERE user_id = $1 ORDER BY id DESC LIMIT 50", [user(req).id])
    return { ok: true, alertas: r.rows }
  })

  // Descarga de salidas: solo del caso propio y dentro de out/<caso>/.
  app.get("/api/archivos/:caso/*", async (req, reply) => {
    const { caso, "*": resto } = req.params as { caso: string; "*": string }
    const r = await o.db.query("SELECT 1 FROM runs WHERE caso = $1 AND user_id = $2", [caso, user(req).id])
    if (!r.rows[0]) return reply.code(404).send({ ok: false, error: "No encontrado." })
    const full = safeJoin(join(paths.out, caso), resto)
    if (!existsSync(full) || !MIME[extname(full)]) return reply.code(404).send({ ok: false, error: "No encontrado." })
    return reply.type(MIME[extname(full)] ?? "application/octet-stream").send(await readFile(full))
  })

  await app.register(fastifyStatic, { root: join(o.directory, "web"), prefix: "/" })
  return { app, services, deps }
}

async function main(): Promise<void> {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "..")
  // .env local opcional (nunca versionado). Las variables ya definidas en el entorno tienen prioridad.
  const envFile = join(directory, ".env")
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const config = loadConfig()
  const problemas = await verificarChecksums(join(directory, "fixtures"))
  if (problemas.length) throw new Error(`Fixtures alterados: ${problemas.join(", ")}`)
  const db = await createDb({ url: config.databaseUrl, dataDir: config.databaseUrl ? undefined : join(directory, ".pgdata") })
  const { usuarios, generada } = parseDemoUsers(config.demoUsers)
  for (const u of usuarios) await upsertUsuario(db, u.email, u.password)
  if (generada) console.log(`\n  Acceso local → usuario: ${usuarios[0]?.email}  clave (generada en este arranque): ${usuarios[0]?.password}\n`)
  const { app, deps } = await construirApp({ directory, config, db, logger: true })
  await app.listen({ host: "0.0.0.0", port: config.port })
  console.log(`  Agente listo en http://localhost:${config.port}  · LLM: ${deps.llm.provider}/${deps.llm.model}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error("No se pudo iniciar:", err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
