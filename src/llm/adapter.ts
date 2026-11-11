/** Interfaz propia del proveedor LLM (PRD §6.1). Cambiar de proveedor no toca el ciclo del agente. */

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface LlmResponse {
  text: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(system: string, mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LlmResponse>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "auth" | "rate_limit" | "proveedor",
  ) {
    super(message)
  }
}
