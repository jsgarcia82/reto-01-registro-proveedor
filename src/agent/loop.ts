import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DomainError } from "../domain/core.js"
import { type ChatMessage, type LlmAdapter, LlmError } from "../llm/adapter.js"
import { registrarAlerta } from "../services/audit.js"
import { cancelarPendientesDeSesion } from "../services/confirmations.js"
import type { PendingConfirmation, Services, ToolContext } from "../services/context.js"
import { ejecutarHerramienta, toolSpecs } from "../tools/registry.js"

export interface AgentDeps {
  services: Services
  llm: LlmAdapter
  directory: string
  maxIterations: number
  maxTokensPerSession: number
}

export interface ToolCallVista {
  id: string
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
  resultado: unknown
}

export interface TurnResult {
  reply: string
  toolCalls: ToolCallVista[]
  needsConfirmation: Omit<PendingConfirmation, never> | null
  error: string | null
}

/** Comportamiento (agent/prompt.md) + conocimiento (src/knowledge/) se cargan de archivos, no del código. */
export function cargarSystemPrompt(directory: string, fechaReferencia: string): string {
  const prompt = readFileSync(join(directory, "agent", "prompt.md"), "utf8")
  const conocimiento = readFileSync(join(directory, "src", "knowledge", "registro-proveedor.md"), "utf8")
  return `${prompt}\n\n---\n# Conocimiento del proceso\n${conocimiento}\n\n---\nFecha de referencia para vigencias: ${fechaReferencia}`
}

const LEASE_MS = 120_000

/** Exclusión entre peticiones concurrentes sobre la MISMA sesión: lease persistido en la BD (sin estado en memoria). */
async function tomarSesion(s: Services, sessionId: string, userId: string): Promise<{ tokensUsed: number }> {
  const now = s.clock.now()
  const r = await s.db.query<{ tokens_used: number }>(
    `UPDATE chat_sessions SET busy_until = $3 WHERE id = $1 AND user_id = $2 AND (busy_until IS NULL OR busy_until < $4) RETURNING tokens_used`,
    [sessionId, userId, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString()],
  )
  if (r.rows[0]) return { tokensUsed: r.rows[0].tokens_used }
  const existe = await s.db.query("SELECT 1 FROM chat_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId])
  if (!existe.rows[0]) throw new DomainError("Sesión no encontrada.", "no_encontrada")
  throw new DomainError("La sesión está procesando otro mensaje; espera a que termine.", "sesion_ocupada")
}

async function guardar(s: Services, sessionId: string, userId: string, role: "user" | "assistant" | "tool" | "event", content: unknown): Promise<void> {
  await s.db.query(
    `INSERT INTO messages (session_id, user_id, seq, role, content, created_at)
     SELECT $1::uuid, $2::uuid, COALESCE(MAX(seq), 0) + 1, $3::text, $4::jsonb, $5::timestamptz FROM messages WHERE session_id = $1::uuid`,
    [sessionId, userId, role, JSON.stringify(content), s.clock.now().toISOString()],
  )
}

export async function historial(s: Services, sessionId: string): Promise<Array<{ role: string; content: unknown; created_at: string }>> {
  const r = await s.db.query<{ role: string; content: unknown; created_at: string }>("SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY seq", [sessionId])
  return r.rows
}

/** Reconstruye los mensajes para el modelo (los eventos de UI no se envían al LLM). */
async function mensajesParaLlm(s: Services, sessionId: string): Promise<ChatMessage[]> {
  return (await historial(s, sessionId)).filter((m) => m.role !== "event").map((m) => m.content as ChatMessage)
}

export async function registrarEvento(s: Services, sessionId: string, userId: string, texto: string): Promise<void> {
  await guardar(s, sessionId, userId, "event", { role: "event", content: texto })
}

/** Ciclo del agente: prompt → modelo → herramientas → ... → respuesta. Tope de iteraciones y de tokens (CA1, costo). */
export async function ejecutarTurno(deps: AgentDeps, p: { sessionId: string; userId: string; message: string }): Promise<TurnResult> {
  const s = deps.services
  const { tokensUsed } = await tomarSesion(s, p.sessionId, p.userId)
  const toolCalls: ToolCallVista[] = []
  let pendiente: PendingConfirmation | null = null
  let tokens = tokensUsed
  try {
    await cancelarPendientesDeSesion(s, p.sessionId) // RN4: la confirmación vale solo para el turno inmediato
    await guardar(s, p.sessionId, p.userId, "user", { role: "user", content: p.message })
    if (tokens >= deps.maxTokensPerSession) {
      const reply = `Se alcanzó el tope de ${deps.maxTokensPerSession} tokens de esta sesión. Abre una sesión nueva para continuar.`
      await guardar(s, p.sessionId, p.userId, "assistant", { role: "assistant", content: reply, toolCalls: [] })
      return { reply, toolCalls, needsConfirmation: null, error: "tope_tokens" }
    }
    const system = cargarSystemPrompt(deps.directory, s.clock.today())
    const ctx: ToolContext = { directory: deps.directory, sessionId: p.sessionId, userId: p.userId, services: s, onConfirmationRequired: (c) => (pendiente = c) }

    for (let i = 0; i < deps.maxIterations; i++) {
      let resp
      try {
        resp = await deps.llm.enviar(system, await mensajesParaLlm(s, p.sessionId), toolSpecs)
      } catch (err) {
        const msg = err instanceof LlmError ? err.message : "Error inesperado al consultar el modelo."
        if (!(err instanceof LlmError)) console.error("[llm]", err)
        const reply = `No pude completar la respuesta: ${msg} La sesión sigue activa; puedes reintentar.`
        await guardar(s, p.sessionId, p.userId, "assistant", { role: "assistant", content: reply, toolCalls: [] })
        await registrarAlerta(s, p.userId, null, { severidad: "advertencia", codigo: "llm_error", mensaje: msg })
        return { reply, toolCalls, needsConfirmation: pendiente, error: "llm" }
      }
      tokens += resp.usage.inputTokens + resp.usage.outputTokens
      await s.db.query("UPDATE chat_sessions SET tokens_used = $2 WHERE id = $1", [p.sessionId, tokens])
      await guardar(s, p.sessionId, p.userId, "assistant", { role: "assistant", content: resp.text, toolCalls: resp.toolCalls })
      if (resp.toolCalls.length === 0) return { reply: resp.text, toolCalls, needsConfirmation: pendiente, error: null }

      for (const tc of resp.toolCalls) {
        const raw = await ejecutarHerramienta(tc.name, tc.args, ctx)
        const parsed = JSON.parse(raw) as { ok: boolean; error?: string; data?: unknown }
        toolCalls.push({ id: tc.id, nombre: tc.name, argumentos: tc.args, ok: parsed.ok, resumen: parsed.ok ? "ok" : (parsed.error ?? "error"), resultado: parsed })
        await guardar(s, p.sessionId, p.userId, "tool", { role: "tool", toolCallId: tc.id, name: tc.name, content: raw })
      }
      if (tokens >= deps.maxTokensPerSession) break
    }
    const reply = `Alcancé el tope de ${deps.maxIterations} pasos (o de tokens) en este turno. Herramientas ejecutadas: ${toolCalls.map((t) => `${t.nombre} (${t.ok ? "ok" : "error"})`).join(", ")}. Pídeme continuar para completar lo que falta.`
    await guardar(s, p.sessionId, p.userId, "assistant", { role: "assistant", content: reply, toolCalls: [] })
    return { reply, toolCalls, needsConfirmation: pendiente, error: "tope_iteraciones" }
  } finally {
    await s.db.query("UPDATE chat_sessions SET busy_until = NULL WHERE id = $1", [p.sessionId])
  }
}
