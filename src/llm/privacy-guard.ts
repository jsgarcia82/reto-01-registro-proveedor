import { redactarTexto } from "../domain/privacy.js"
import type { ChatMessage, LlmAdapter, LlmResponse, ToolSpec } from "./adapter.js"

/**
 * Defensa en profundidad (anti_error_1_6): aunque las herramientas ya entregan vistas minimizadas,
 * todo texto que sale hacia el proveedor pasa por esta guarda (p. ej. si el usuario pega un número de cuenta).
 */
export class PrivacyGuardAdapter implements LlmAdapter {
  constructor(
    private readonly inner: LlmAdapter,
    private readonly sensibles: Array<{ ruta: string; valor: string }>,
  ) {}
  get provider(): string {
    return this.inner.provider
  }
  get model(): string {
    return this.inner.model
  }
  enviar(system: string, mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LlmResponse> {
    const r = (t: string) => redactarTexto(t, this.sensibles)
    const limpios = mensajes.map((m): ChatMessage => {
      if (m.role === "tool") return { ...m, content: r(m.content) }
      if (m.role === "assistant") return { ...m, content: r(m.content), toolCalls: m.toolCalls.map((tc) => ({ ...tc, args: JSON.parse(r(JSON.stringify(tc.args ?? {}))) as unknown })) }
      return { ...m, content: r(m.content) }
    })
    return this.inner.enviar(r(system), limpios, herramientas)
  }
}
