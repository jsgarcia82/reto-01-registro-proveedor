import type { FastifyInstance } from "fastify"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { loadConfig } from "../src/config.js"
import { type LlmAdapter, LlmError } from "../src/llm/adapter.js"
import { construirApp } from "../src/server.js"
import { upsertUsuario } from "../src/services/users.js"
import { entorno, type Entorno, FIXTURES, ROOT } from "./helpers.js"

/** Flujo REAL por HTTP (front → API → ciclo del agente → herramientas → archivos) con el LLM simulado. */
describe("e2e HTTP — prompt de demo del PRD §11", () => {
  let e: Entorno
  let app: FastifyInstance
  const config = loadConfig({ LLM_PROVIDER: "mock" })

  async function login(email: string, password: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: "/api/login", payload: { email, password } })
    expect(r.statusCode).toBe(200)
    const c = r.cookies.find((x) => x.name === "sid")
    expect(c?.httpOnly).toBe(true)
    expect(c?.sameSite).toBe("Strict")
    return `sid=${c?.value ?? ""}`
  }
  const post = (url: string, cookie: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } })

  beforeEach(async () => {
    e = await entorno({ asOf: "2026-11-10" })
    await upsertUsuario(e.db, "ana@demo.local", "clave-ana")
    await upsertUsuario(e.db, "beto@demo.local", "clave-beto")
    ;({ app } = await construirApp({ directory: ROOT, config, db: e.db, clock: e.clock, paths: { fixtures: FIXTURES, out: e.paths.out } }))
  })
  afterEach(async () => {
    await app.close()
    await e.limpiar()
  })

  it("API protegida: sin sesión 401, clave errónea 401, health público sin secretos", async () => {
    expect((await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: e.sesionA, message: "hola" } })).statusCode).toBe(401)
    expect((await app.inject({ method: "GET", url: `/api/sessions/${e.sesionA}` })).statusCode).toBe(401)
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { email: "ana@demo.local", password: "mala" } })).statusCode).toBe(401)
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ ok: true, provider: "mock", model: "mock-determinista-v1" })
  })

  it("procesa ec-corp-andina, pide confirmación al decir 'envía' y solo el humano produce ENVIO-SIMULADO.md", async () => {
    const ana = await login("ana@demo.local", "clave-ana")
    const sid = (await post("/api/sessions", ana, {})).json<{ sessionId: string }>().sessionId
    const t1 = (
      await post("/api/chat", ana, {
        sessionId: sid,
        message: 'Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.',
      })
    ).json<{ reply: string; toolCalls: Array<{ nombre: string; ok: boolean }>; needsConfirmation: unknown }>()
    expect(t1.toolCalls.map((t) => t.nombre)).toEqual(["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"])
    expect(t1.reply).toMatch(/listo_para_firma: no/)
    expect(t1.reply).toMatch(/certificado_cumplimiento_tributario \(ausente\)/)
    expect(t1.reply).toMatch(/out\/ec-corp-andina/)
    expect(t1.reply.trim().endsWith("resaltado.")).toBe(true)
    expect(t1.reply).toMatch(/\?/)
    expect(t1.needsConfirmation).toBeNull()
    const envio = join(e.paths.out, "ec-corp-andina", "ENVIO-SIMULADO.md")
    expect(existsSync(envio)).toBe(false)

    const t2 = (await post("/api/chat", ana, { sessionId: sid, message: "envía" })).json<{ needsConfirmation: { token: string; listoParaFirma: boolean; bloqueos: string[] } }>()
    expect(t2.needsConfirmation.listoParaFirma).toBe(false)
    expect(t2.needsConfirmation.bloqueos.length).toBe(2)
    expect(existsSync(envio)).toBe(false) // pedir enviar no envía

    const beto = await login("beto@demo.local", "clave-beto")
    expect((await post("/api/confirmaciones", beto, { token: t2.needsConfirmation.token })).statusCode).toBe(409) // otro usuario
    expect(existsSync(envio)).toBe(false)

    const c = await post("/api/confirmaciones", ana, { token: t2.needsConfirmation.token })
    expect(c.json()).toMatchObject({ ok: true, ruta: "out/ec-corp-andina/ENVIO-SIMULADO.md", repetido: false })
    expect(await readFile(envio, "utf8")).toContain("ana@demo.local")
    expect((await post("/api/confirmaciones", ana, { token: t2.needsConfirmation.token })).statusCode).toBe(409) // un solo uso

    const h = (await app.inject({ method: "GET", url: `/api/sessions/${sid}`, headers: { cookie: ana } })).json<{ mensajes: Array<{ role: string }> }>()
    expect(h.mensajes.filter((m) => m.role === "tool")).toHaveLength(5) // CA4: toda llamada queda en el historial
    expect(h.mensajes.at(-1)?.role).toBe("event")
    const alertas = (await app.inject({ method: "GET", url: "/api/alertas", headers: { cookie: ana } })).json<{ alertas: Array<{ codigo: string }> }>()
    expect(alertas.alertas.map((a) => a.codigo)).toContain("envio_con_bloqueos")
  })

  it("sesiones no públicas: el historial y los archivos de otro usuario responden 404", async () => {
    const ana = await login("ana@demo.local", "clave-ana")
    const beto = await login("beto@demo.local", "clave-beto")
    const sid = (await post("/api/sessions", ana, {})).json<{ sessionId: string }>().sessionId
    await post("/api/chat", ana, { sessionId: sid, message: 'Procesa el caso "co-industrias-delta"' })
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sid}`, headers: { cookie: beto } })).statusCode).toBe(404)
    expect((await post("/api/chat", beto, { sessionId: sid, message: "hola" })).statusCode).toBe(404)
    expect((await app.inject({ method: "GET", url: "/api/archivos/co-industrias-delta/formulario.xlsx", headers: { cookie: beto } })).statusCode).toBe(404)
    expect((await app.inject({ method: "GET", url: "/api/archivos/co-industrias-delta/formulario.xlsx", headers: { cookie: ana } })).statusCode).toBe(200)
    expect((await app.inject({ method: "GET", url: "/api/archivos/co-industrias-delta/..%2F..%2Ffixtures%2Freto-01%2Frepositorio%2Fmaestro.json", headers: { cookie: ana } })).statusCode).toBeGreaterThanOrEqual(400)
  })

  it("validación de entradas: sessionId no uuid o mensaje vacío → 400", async () => {
    const ana = await login("ana@demo.local", "clave-ana")
    expect((await post("/api/chat", ana, { sessionId: "x", message: "hola" })).statusCode).toBe(400)
    expect((await post("/api/chat", ana, { sessionId: e.sesionA, message: "   " })).statusCode).toBe(400)
  })
})

describe("Ciclo del agente — topes y errores del proveedor (CA1, CA5)", () => {
  let e: Entorno
  afterEach(() => e.limpiar())
  const crear = async (llm: LlmAdapter, extra: Record<string, string> = {}) => {
    e = await entorno()
    await upsertUsuario(e.db, "ana@demo.local", "clave-ana")
    const { app } = await construirApp({ directory: ROOT, config: loadConfig({ LLM_PROVIDER: "mock", ...extra }), db: e.db, clock: e.clock, llm, paths: { fixtures: FIXTURES, out: e.paths.out } })
    const r = await app.inject({ method: "POST", url: "/api/login", payload: { email: "ana@demo.local", password: "clave-ana" } })
    const cookie = `sid=${r.cookies.find((c) => c.name === "sid")?.value ?? ""}`
    const sid = (await app.inject({ method: "POST", url: "/api/sessions", payload: {}, headers: { cookie } })).json<{ sessionId: string }>().sessionId
    return { app, cookie, sid }
  }

  it("tope de iteraciones: un modelo que nunca termina se corta y responde con lo que tiene", async () => {
    const bucle: LlmAdapter = { provider: "t", model: "bucle", enviar: async () => ({ text: "", toolCalls: [{ id: `x${Math.random()}`, name: "proveedor_leer_solicitud", args: { caso: "co-industrias-delta" } }], usage: { inputTokens: 1, outputTokens: 1 } }) }
    const { app, cookie, sid } = await crear(bucle, { MAX_ITERATIONS_PER_TURN: "3" })
    const r = (await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: sid, message: "hola" }, headers: { cookie } })).json<{ reply: string; toolCalls: unknown[]; error: string }>()
    expect(r.error).toBe("tope_iteraciones")
    expect(r.toolCalls).toHaveLength(3)
    expect(r.reply).toMatch(/tope de 3 pasos/)
    await app.close()
  })

  it("timeout del proveedor: mensaje claro, sin traza, y la sesión sigue viva", async () => {
    let falla = true
    const fragil: LlmAdapter = {
      provider: "t",
      model: "fragil",
      enviar: async () => {
        if (falla) throw new LlmError("El modelo no respondió a tiempo (timeout).", "timeout")
        return { text: "de vuelta", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { app, cookie, sid } = await crear(fragil)
    const r1 = (await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: sid, message: "hola" }, headers: { cookie } })).json<{ reply: string }>()
    expect(r1.reply).toMatch(/timeout/)
    expect(r1.reply).not.toMatch(/at .*:\d+/)
    falla = false
    const r2 = (await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: sid, message: "hola" }, headers: { cookie } })).json<{ reply: string }>()
    expect(r2.reply).toBe("de vuelta")
    await app.close()
  })

  it("tope de tokens por sesión: no se puede gastar la clave sin límite", async () => {
    const caro: LlmAdapter = { provider: "t", model: "caro", enviar: async () => ({ text: "ok", toolCalls: [], usage: { inputTokens: 600, outputTokens: 500 } }) }
    const { app, cookie, sid } = await crear(caro, { MAX_TOKENS_PER_SESSION: "1000" })
    await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: sid, message: "uno" }, headers: { cookie } })
    const r = (await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: sid, message: "dos" }, headers: { cookie } })).json<{ error: string }>()
    expect(r.error).toBe("tope_tokens")
    await app.close()
  })
})
