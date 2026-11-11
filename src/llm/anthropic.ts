import Anthropic from "@anthropic-ai/sdk"
import { type ChatMessage, type LlmAdapter, LlmError, type LlmResponse, type ToolSpec } from "./adapter.js"

/** Tipos mínimos del Messages API que usa este adaptador (permite inyectar un cliente espía en pruebas). */
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export interface AnthropicRequest {
  model: string
  max_tokens: number
  system: string
  messages: Array<{ role: "user" | "assistant"; content: string | Block[] }>
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
}
export interface AnthropicResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
  usage: { input_tokens: number; output_tokens: number }
}
export interface AnthropicLikeClient {
  messages: { create(req: AnthropicRequest): Promise<AnthropicResponse> }
}

export function toAnthropicMessages(mensajes: ChatMessage[]): AnthropicRequest["messages"] {
  const out: AnthropicRequest["messages"] = []
  for (const m of mensajes) {
    if (m.role === "user") out.push({ role: "user", content: m.content })
    else if (m.role === "assistant") {
      const blocks: Block[] = []
      if (m.content) blocks.push({ type: "text", text: m.content })
      for (const tc of m.toolCalls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} })
      if (blocks.length) out.push({ role: "assistant", content: blocks })
    } else {
      const block: Block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: !(JSON.parse(m.content) as { ok?: boolean }).ok }
      const last = out[out.length - 1]
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block)
      else out.push({ role: "user", content: [block] })
    }
  }
  return out
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  constructor(
    readonly model: string,
    private readonly client: AnthropicLikeClient,
    private readonly maxTokens = 2048,
  ) {}

  static fromEnv(apiKey: string, model: string, timeoutMs: number): AnthropicAdapter {
    const sdk = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 })
    return new AnthropicAdapter(model, sdk as unknown as AnthropicLikeClient)
  }

  async enviar(system: string, mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LlmResponse> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages: toAnthropicMessages(mensajes),
        tools: herramientas.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      })
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim()
      const toolCalls = res.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} }))
      return { text, toolCalls, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } }
    } catch (err) {
      const name = err instanceof Error ? err.constructor.name : ""
      const status = (err as { status?: number }).status
      // Nunca se propaga el mensaje crudo del proveedor (podría incluir detalles de la petición).
      if (name.includes("Timeout")) throw new LlmError("El modelo no respondió a tiempo (timeout).", "timeout")
      if (status === 401 || status === 403) throw new LlmError("La clave del proveedor LLM es inválida o no tiene permisos.", "auth")
      if (status === 429) throw new LlmError("El proveedor LLM limitó la tasa de peticiones; intenta en unos segundos.", "rate_limit")
      throw new LlmError("El proveedor LLM devolvió un error.", "proveedor")
    }
  }
}
