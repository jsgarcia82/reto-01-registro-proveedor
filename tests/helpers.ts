import { randomBytes } from "node:crypto"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { createDb, type Db } from "../src/db/db.js"
import { fixedClock, type FixedClock } from "../src/domain/core.js"
import type { Paths } from "../src/domain/fixtures.js"
import type { PendingConfirmation, Services, ToolContext } from "../src/services/context.js"
import { crearSesionChat, upsertUsuario, type Usuario } from "../src/services/users.js"
import { herramientas } from "../src/tools/proveedor.js"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const FIXTURES = join(ROOT, "fixtures", "reto-01")
export const SENSIBLES = ["03100012345", "COLOCOBM", "71555123"]

/** BD de prueba: PGlite en memoria; con TEST_DATABASE_URL usa Postgres real con un esquema aislado. */
export async function dbPrueba(): Promise<{ db: Db; limpiar: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    const db = await createDb()
    return { db, limpiar: () => db.close() }
  }
  const schema = `t_${randomBytes(6).toString("hex")}`
  const db = await createDb({ url, schema })
  return {
    db,
    limpiar: async () => {
      await db.close()
      const c = new pg.Client({ connectionString: url })
      await c.connect()
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await c.end()
    },
  }
}

export interface Entorno {
  db: Db
  clock: FixedClock
  paths: Paths
  services: Services
  a: Usuario
  b: Usuario
  sesionA: string
  sesionA2: string
  sesionB: string
  ctx(userId: string, sessionId: string, onConf?: (c: PendingConfirmation) => void): ToolContext
  limpiar(): Promise<void>
}

export async function entorno(opts: { asOf?: string; fixtures?: string } = {}): Promise<Entorno> {
  const { db, limpiar } = await dbPrueba()
  const out = await mkdtemp(join(tmpdir(), "reto01-out-"))
  const clock = fixedClock("2026-11-10T15:00:00.000Z", opts.asOf)
  const paths: Paths = { fixtures: opts.fixtures ?? FIXTURES, out }
  const services: Services = { db, clock, paths, config: { confirmationTtlSeconds: 600 } }
  const a = await upsertUsuario(db, "analista-a@test.local", "clave-a")
  const b = await upsertUsuario(db, "analista-b@test.local", "clave-b")
  const [sesionA, sesionA2, sesionB] = [await crearSesionChat(db, a.id), await crearSesionChat(db, a.id), await crearSesionChat(db, b.id)]
  return {
    db,
    clock,
    paths,
    services,
    a,
    b,
    sesionA,
    sesionA2,
    sesionB,
    ctx: (userId, sessionId, onConf) => ({ directory: ROOT, sessionId, userId, services, ...(onConf ? { onConfirmationRequired: onConf } : {}) }),
    limpiar: async () => {
      await limpiar()
      await rm(out, { recursive: true, force: true })
    },
  }
}

/** Resultado de herramienta para aserciones. Único `any` del repo: acceso dinámico a JSON solo en pruebas. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Res = { ok: boolean; error?: string; data?: any; [k: string]: unknown }

export async function tool(nombre: keyof typeof herramientas, args: unknown, ctx: ToolContext): Promise<Res> {
  const raw = await herramientas[nombre].execute(args, ctx)
  expect(typeof raw).toBe("string")
  return JSON.parse(raw) as Res
}

/** Flujo completo hasta paquete armado. */
export async function procesar(caso: string, ctx: ToolContext): Promise<{ leer: Res; mapeo: Res; gen: Res; paq: Res }> {
  const leer = await tool("leer_solicitud", { caso }, ctx)
  const campos = ((leer.data?.campos ?? []) as Array<{ etiqueta: string }>).map((c) => c.etiqueta)
  const mapeo = await tool("mapear_campos", { caso, campos }, ctx)
  const gen = mapeo.ok ? await tool("generar_formulario", { caso, mapeo: mapeo.data.mapeo_hash }, ctx) : mapeo
  const paq = await tool("armar_paquete", { caso }, ctx)
  return { leer, mapeo, gen, paq }
}

/** Pide confirmación (como lo haría el modelo) y devuelve el token que recibiría el front. */
export async function pedirConfirmacion(caso: string, e: Entorno, userId: string, sessionId: string): Promise<PendingConfirmation> {
  let pend: PendingConfirmation | null = null
  const r = await tool("simular_envio", { caso, confirmado: true }, e.ctx(userId, sessionId, (c) => (pend = c)))
  expect(r.ok).toBe(false)
  expect(r.error).toBe("requiere confirmación explícita")
  if (!pend) throw new Error("no se emitió confirmación")
  return pend
}

export async function copiaFixtures(): Promise<{ dir: string; limpiar: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "reto01-fx-"))
  await cp(FIXTURES, dir, { recursive: true })
  return { dir, limpiar: () => rm(dir, { recursive: true, force: true }) }
}
