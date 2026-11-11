import { join } from "node:path"
import type { Queryable } from "../db/db.js"
import { appendLine } from "../docs/files.js"
import type { Services } from "./context.js"

export interface AuditEntry {
  userId: string
  sessionId: string | null
  runId: string | null
  caso: string | null
  evento: string
  ok: boolean
  resumen: string
}

/**
 * Trazabilidad (CA4 / RN5): tabla audit_log + out/log.jsonl + out/<caso>/log.jsonl.
 * El resumen nunca contiene datos sensibles (lo construye código determinista).
 */
export async function registrarAuditoria(s: Services, entry: AuditEntry, q: Queryable = s.db): Promise<void> {
  await q.query("INSERT INTO audit_log (user_id, session_id, run_id, evento, ok, resumen, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    entry.userId,
    entry.sessionId,
    entry.runId,
    entry.evento,
    entry.ok,
    entry.resumen,
    s.clock.now().toISOString(),
  ])
  const line = JSON.stringify({ ts: s.clock.now().toISOString(), herramienta: entry.evento, ok: entry.ok, resumen: entry.resumen, caso: entry.caso, sessionId: entry.sessionId })
  await appendLine(join(s.paths.out, "log.jsonl"), line)
  if (entry.caso) await appendLine(join(s.paths.out, entry.caso, "log.jsonl"), line)
}

export type Severidad = "info" | "advertencia" | "critica"

export interface Alerta {
  severidad: Severidad
  codigo: string
  mensaje: string
}

export async function registrarAlerta(s: Services, userId: string, runId: string | null, a: Alerta, q: Queryable = s.db): Promise<void> {
  await q.query("INSERT INTO alerts (user_id, run_id, severidad, codigo, mensaje, ts) VALUES ($1,$2,$3,$4,$5,$6)", [
    userId,
    runId,
    a.severidad,
    a.codigo,
    a.mensaje,
    s.clock.now().toISOString(),
  ])
}
