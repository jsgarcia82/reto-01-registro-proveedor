/**
 * demo.ts — ejecuta TODAS las herramientas sobre TODOS los casos, sin modelo de lenguaje ni clave.
 *   npm run demo        (equivale a: npx tsx demo.ts)
 * Determinista: out/ se limpia al inicio; dos escenarios de fecha de referencia explican las vigencias.
 */
import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createDb } from "./src/db/db.js"
import { fixedClock, type Result } from "./src/domain/core.js"
import { cargarCaso, cargarMaestro, listarCasos, verificarChecksums, type Paths } from "./src/domain/fixtures.js"
import { contieneSensible, valoresSensibles } from "./src/domain/privacy.js"
import { confirmarEnvio } from "./src/services/confirmations.js"
import type { PendingConfirmation, Services, ToolContext } from "./src/services/context.js"
import { crearSesionChat, upsertUsuario } from "./src/services/users.js"
import { herramientas } from "./src/tools/proveedor.js"

const ROOT = dirname(fileURLToPath(import.meta.url))
const paths: Paths = { fixtures: join(ROOT, "fixtures", "reto-01"), out: join(ROOT, "out") }
const NOW = "2026-11-10T15:00:00.000Z" // instante fijo para que la demo sea reproducible
const HOY = process.env.AS_OF_DATE?.trim() || NOW.slice(0, 10)

type Data = Record<string, unknown>
const salidas: string[] = []
async function call(nombre: keyof typeof herramientas, args: Data, ctx: ToolContext): Promise<Result<Data> & Data> {
  const raw = await herramientas[nombre].execute(args, ctx)
  salidas.push(raw)
  return JSON.parse(raw) as Result<Data> & Data
}
const lista = (x: unknown): string[] => (Array.isArray(x) ? x.map((v) => (typeof v === "string" ? v : String((v as { etiqueta?: string }).etiqueta ?? JSON.stringify(v)))) : [])

async function escenario(titulo: string, asOfPorCaso: (fechaSolicitud: string) => string, conEnvio: boolean): Promise<void> {
  console.log(`\n=== Escenario: ${titulo} ===`)
  await rm(paths.out, { recursive: true, force: true })
  await mkdir(paths.out, { recursive: true })
  const db = await createDb()
  const user = await upsertUsuario(db, "demo@local", "demo-sin-login")
  const sessionId = await crearSesionChat(db, user.id)
  let ctxEnvio: ToolContext | null = null
  for (const caso of await listarCasos(paths)) {
    const k = await cargarCaso(paths, caso)
    const asOf = asOfPorCaso(k.solicitud.fecha)
    const services: Services = { db, clock: fixedClock(NOW, asOf), paths, config: { confirmationTtlSeconds: 600 } }
    const ctx: ToolContext = { directory: ROOT, sessionId, userId: user.id, services }
    const leer = await call("leer_solicitud", { caso }, ctx)
    if (!leer.ok) {
      console.log(`- ${caso}: ERROR ${leer.error}`)
      continue
    }
    const d = leer.data
    const mapeo = await call("mapear_campos", { caso, campos: lista(d.campos) }, ctx)
    const gen = mapeo.ok ? await call("generar_formulario", { caso, mapeo: mapeo.data.mapeo_hash }, ctx) : mapeo
    const paq = await call("armar_paquete", { caso }, ctx)
    console.log(`\n- ${caso}  [${String(d.pais)} · ${String(d.formato)} · referencia ${asOf}]`)
    if (mapeo.ok) {
      console.log(`  campos: ${lista(mapeo.data.llenos).length} llenos · faltantes: ${JSON.stringify(lista(mapeo.data.faltantes))} · por confirmar: ${JSON.stringify(lista(mapeo.data.requiere_confirmacion))}`)
    }
    console.log(`  formulario: ${gen.ok ? `${String(gen.data.ruta)}${gen.data.soportado === false ? " (formato no soportado → valores para copiar)" : ""}` : gen.error}`)
    if (paq.ok) console.log(`  paquete: ${String(paq.data.ruta)} · listo_para_firma=${String(paq.data.listo_para_firma)}${lista(paq.data.bloqueos).length ? ` · bloqueos: ${lista(paq.data.bloqueos).join("; ")}` : ""}`)
    else console.log(`  paquete: ERROR ${paq.error}`)
    if (caso === "ec-corp-andina") ctxEnvio = ctx
  }

  if (conEnvio && ctxEnvio) {
    console.log("\n  HITL (ec-corp-andina):")
    const sinConfirmar = await call("simular_envio", { caso: "ec-corp-andina", confirmado: false }, ctxEnvio)
    console.log(`  1) simular_envio(confirmado=false) → ${sinConfirmar.ok ? "ok" : sinConfirmar.error}`)
    let pendiente: PendingConfirmation | null = null
    const conCtx: ToolContext = { ...ctxEnvio, onConfirmationRequired: (c) => (pendiente = c) }
    const pide = await call("simular_envio", { caso: "ec-corp-andina", confirmado: true }, conCtx)
    console.log(`  2) simular_envio(confirmado=true) → ${pide.ok ? "ok" : pide.error}; token emitido solo al front: ${pendiente ? "sí" : "no"}`)
    const p = pendiente as PendingConfirmation | null
    if (p) {
      const r = await confirmarEnvio(ctxEnvio.services, { token: p.token, userId: ctxEnvio.userId, userEmail: "demo@local" })
      console.log(`  3) humano confirma (token ligado a versión ${p.version} y hash ${p.payloadHash.slice(0, 12)}) → ${r.ruta}`)
      const otra = await confirmarEnvio(ctxEnvio.services, { token: p.token, userId: ctxEnvio.userId, userEmail: "demo@local" }).then(
        () => "aceptado (ERROR)",
        (e: Error) => `rechazado: ${e.message}`,
      )
      console.log(`  4) reutilizar el mismo token → ${otra}`)
      const again = await call("simular_envio", { caso: "ec-corp-andina", confirmado: true }, ctxEnvio)
      console.log(`  5) simular_envio otra vez → ${again.ok ? `idempotente, ya enviado: ${String(again.data.ruta)}` : again.error}`)
    }
  }
  await db.close()
}

const problemas = await verificarChecksums(join(ROOT, "fixtures"))
console.log(`Fixtures: ${problemas.length === 0 ? "íntegros (CHECKSUMS.sha256 OK)" : `ALTERADOS → ${problemas.join(", ")}`}`)

await escenario("vigencias a la fecha de cada solicitud", (fecha) => fecha, false)
await escenario(`vigencias a la fecha de ejecución (${HOY})`, () => HOY, true)

const sensibles = valoresSensibles(await cargarMaestro(paths))
const fugas = salidas.filter((s) => contieneSensible(s, sensibles)).length
console.log(`\nPrivacidad: ${fugas} salidas de herramientas con cuenta/SWIFT/cédula en claro (de ${salidas.length}).`)
const envio = await readFile(join(paths.out, "ec-corp-andina", "ENVIO-SIMULADO.md"), "utf8").catch(() => "")
console.log(`Envío simulado: ${envio ? "out/ec-corp-andina/ENVIO-SIMULADO.md creado tras confirmación humana" : "no creado"}`)
console.log(`Log de auditoría: out/log.jsonl y out/<caso>/log.jsonl`)
process.exit(problemas.length === 0 && fugas === 0 ? 0 : 1)
