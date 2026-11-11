import { randomUUID } from "node:crypto"
import type { Queryable } from "../db/db.js"
import { DomainError } from "../domain/core.js"
import type { Services } from "./context.js"

/** Máquina de estados del caso. Cada transición es compare-and-set sobre (version, state, user_id). */
export const ESTADOS = ["leido", "mapeado", "formulario_generado", "paquete_armado", "confirmacion_pendiente", "enviado"] as const
export type Estado = (typeof ESTADOS)[number]

export interface Run {
  id: string
  caso: string
  user_id: string
  session_id: string | null
  state: Estado
  version: number
  formato: string
  mapping: unknown
  mapping_hash: string | null
  formulario: unknown
  payload: unknown
  payload_hash: string | null
  listo_para_firma: boolean | null
  as_of: string | null
}

export class ConflictError extends DomainError {
  constructor(message = "Conflicto de concurrencia: otra sesión modificó este caso. Vuelve a consultar su estado y reintenta.") {
    super(message, "conflicto")
  }
}

/** Transiciones permitidas: estado destino → estados origen válidos. */
export const TRANSICIONES: Record<Exclude<Estado, "leido">, Estado[]> = {
  mapeado: ["leido", "mapeado", "formulario_generado", "paquete_armado", "confirmacion_pendiente", "enviado"],
  formulario_generado: ["mapeado", "formulario_generado", "paquete_armado", "confirmacion_pendiente"],
  paquete_armado: ["leido", "mapeado", "formulario_generado", "paquete_armado", "confirmacion_pendiente"],
  confirmacion_pendiente: ["paquete_armado", "confirmacion_pendiente"],
  enviado: ["confirmacion_pendiente"],
}

export async function obtenerRun(q: Queryable, caso: string): Promise<Run | null> {
  const r = await q.query<Run>("SELECT * FROM runs WHERE caso = $1", [caso])
  return r.rows[0] ?? null
}

/** Run del caso para este usuario; error claro si pertenece a otro usuario. */
export async function obtenerRunPropio(q: Queryable, caso: string, userId: string): Promise<Run | null> {
  const run = await obtenerRun(q, caso)
  if (run && run.user_id !== userId) throw new DomainError(`El caso "${caso}" está asignado a otro usuario.`, "caso_ajeno")
  return run
}

/** Crea el run del caso (UNIQUE(caso) resuelve la carrera entre usuarios). */
export async function asegurarRun(s: Services, p: { caso: string; userId: string; sessionId: string; formato: string }): Promise<Run> {
  const existente = await obtenerRunPropio(s.db, p.caso, p.userId)
  if (existente) return existente
  try {
    await s.db.query("INSERT INTO runs (id, caso, user_id, session_id, state, version, formato, updated_at) VALUES ($1,$2,$3,$4,'leido',1,$5,$6)", [
      randomUUID(),
      p.caso,
      p.userId,
      p.sessionId,
      p.formato,
      s.clock.now().toISOString(),
    ])
  } catch {
    // otro proceso lo creó primero: se relee y se valida propiedad
  }
  const run = await obtenerRunPropio(s.db, p.caso, p.userId)
  if (!run) throw new DomainError("No se pudo registrar el caso.", "run")
  return run
}

const COLUMNAS_PATCH = ["mapping", "mapping_hash", "formulario", "payload", "payload_hash", "listo_para_firma", "as_of", "session_id"] as const
type Patch = Partial<Record<(typeof COLUMNAS_PATCH)[number], unknown>>

/**
 * Compare-and-set: UPDATE ... WHERE id AND user_id AND version = esperada AND state IN (origenes).
 * Si no afecta filas → ConflictError. efecto() corre dentro de la misma transacción (rollback si falla).
 */
export async function transicionar<T>(
  s: Services,
  p: { run: Run; userId: string; hacia: Exclude<Estado, "leido">; patch?: Patch },
  efecto?: (q: Queryable, nuevo: Run) => Promise<T>,
): Promise<{ run: Run; resultado: T | undefined }> {
  const origenes = TRANSICIONES[p.hacia]
  const patch = p.patch ?? {}
  const cols = COLUMNAS_PATCH.filter((c) => c in patch)
  const params: unknown[] = [p.run.id, p.userId, p.run.version, p.hacia, s.clock.now().toISOString()]
  const sets = cols.map((c) => {
    const v = patch[c]
    params.push(c === "mapping" || c === "formulario" || c === "payload" ? JSON.stringify(v) : v)
    return `${c} = $${params.length}`
  })
  const inList = origenes.map((o) => {
    params.push(o)
    return `$${params.length}`
  })
  const sql = `UPDATE runs SET state = $4, version = version + 1, updated_at = $5${sets.length ? ", " + sets.join(", ") : ""}
               WHERE id = $1 AND user_id = $2 AND version = $3 AND state IN (${inList.join(", ")}) RETURNING *`
  return s.db.tx(async (q) => {
    const r = await q.query<Run>(sql, params)
    const nuevo = r.rows[0]
    if (!nuevo) {
      const actual = await obtenerRun(q, p.run.caso)
      if (actual && actual.version === p.run.version && !origenes.includes(actual.state))
        throw new DomainError(`Acción no permitida en el estado "${actual.state}" del caso.`, "estado_invalido")
      throw new ConflictError()
    }
    const resultado = efecto ? await efecto(q, nuevo) : undefined
    return { run: nuevo, resultado }
  })
}
