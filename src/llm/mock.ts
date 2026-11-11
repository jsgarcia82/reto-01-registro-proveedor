import type { ChatMessage, LlmAdapter, LlmResponse, ToolCall, ToolSpec } from "./adapter.js"

/**
 * LLM simulado DETERMINISTA: permite `npm test`, la CI y la demo web sin clave de API.
 * Sigue el mismo protocolo de tool use que el modelo real (decide herramientas, lee resultados, redacta).
 */
type R = { ok: boolean; error?: string; data?: Record<string, unknown> }

const parse = (s: string): R => {
  try {
    return JSON.parse(s) as R
  } catch {
    return { ok: false, error: "respuesta ilegible" }
  }
}
const etiquetas = (x: unknown): string[] => (Array.isArray(x) ? x.map((v) => String((v as { etiqueta?: unknown }).etiqueta ?? v)) : [])

export class MockLlm implements LlmAdapter {
  readonly provider = "mock"
  readonly model = "mock-determinista-v1"
  private n = 0
  constructor(private readonly casos: string[]) {}

  private call(name: string, args: Record<string, unknown>): LlmResponse {
    this.n++
    const toolCalls: ToolCall[] = [{ id: `toolu_mock_${this.n}`, name, args }]
    return { text: "", toolCalls, usage: { inputTokens: 0, outputTokens: 0 } }
  }
  private say(text: string, entrada: ChatMessage[]): LlmResponse {
    const chars = entrada.reduce((a, m) => a + m.content.length, 0)
    return { text, toolCalls: [], usage: { inputTokens: Math.ceil(chars / 4), outputTokens: Math.ceil(text.length / 4) } }
  }

  private detectarCaso(texto: string, historia: ChatMessage[]): string | null {
    const enTexto = this.casos.find((c) => texto.includes(c))
    if (enTexto) return enTexto
    for (let i = historia.length - 1; i >= 0; i--) {
      const m = historia[i]
      if (m?.role === "assistant") for (const tc of m.toolCalls) if (typeof (tc.args as { caso?: unknown }).caso === "string") return (tc.args as { caso: string }).caso
    }
    return null
  }

  async enviar(_system: string, mensajes: ChatMessage[], _h: ToolSpec[]): Promise<LlmResponse> {
    const last = mensajes[mensajes.length - 1]
    if (!last) return this.say("¿En qué caso trabajamos?", mensajes)
    const iUser = mensajes.map((m) => m.role).lastIndexOf("user")
    const userText = iUser >= 0 ? (mensajes[iUser] as { content: string }).content : ""
    const turno = mensajes.slice(iUser + 1)

    if (last.role === "user") {
      const t = last.content.toLowerCase()
      const pideEnvio = /\b(env[ií]a|enviar|envíalo|envialo)\b/.test(t) && !/no env[ií]es|no enviar|todav[ií]a no/.test(t)
      const caso = this.detectarCaso(last.content, mensajes.slice(0, -1))
      if (pideEnvio) return caso ? this.call("proveedor_simular_envio", { caso, confirmado: true }) : this.say("¿Qué caso quieres enviar?", mensajes)
      if (caso && this.casos.some((c) => last.content.includes(c))) return this.call("proveedor_leer_solicitud", { caso })
      return this.say(`Puedo procesar estos casos: ${this.casos.join(", ")}. Escribe, por ejemplo: Procesa el caso "${this.casos[0] ?? ""}".`, mensajes)
    }

    if (last.role !== "tool") return this.say("Listo.", mensajes)
    const res = parse(last.content)
    const caso = this.detectarCaso(userText, mensajes)
    switch (last.name) {
      case "proveedor_leer_solicitud":
        if (!res.ok) return this.say(`No pude leer la solicitud: ${res.error ?? ""}`, mensajes)
        if (etiquetas(res.data?.campos).length === 0) return this.call("proveedor_armar_paquete", { caso })
        return this.call("proveedor_mapear_campos", { caso, campos: etiquetas(res.data?.campos) })
      case "proveedor_mapear_campos":
        if (!res.ok) return this.call("proveedor_armar_paquete", { caso })
        return this.call("proveedor_generar_formulario", { caso, mapeo: res.data?.mapeo_hash })
      case "proveedor_generar_formulario":
        return this.call("proveedor_armar_paquete", { caso })
      case "proveedor_armar_paquete":
        return this.say(this.resumen(turno), mensajes)
      case "proveedor_simular_envio":
        if (res.ok) return this.say(`Envío simulado registrado: ${String(res.data?.ruta ?? "")}.`, mensajes)
        if (res.error === "requiere confirmación explícita")
          return this.say("No envío nada sin tu confirmación explícita. Revisa el resumen resaltado (versión, hash y bloqueos) y pulsa **Confirmar envío** si estás de acuerdo.", mensajes)
        return this.say(`No se pudo preparar el envío: ${res.error ?? ""}`, mensajes)
      default:
        return this.say("Herramienta desconocida.", mensajes)
    }
  }

  private resumen(turno: ChatMessage[]): string {
    const get = (n: string): R | null => {
      const m = [...turno].reverse().find((x) => x.role === "tool" && x.name === n)
      return m && m.role === "tool" ? parse(m.content) : null
    }
    const leer = get("proveedor_leer_solicitud")
    const map = get("proveedor_mapear_campos")
    const gen = get("proveedor_generar_formulario")
    const paq = get("proveedor_armar_paquete")
    const l: string[] = []
    if (leer?.ok) l.push(`**Caso ${String(leer.data?.caso)}** — ${String(leer.data?.cliente)} (${String(leer.data?.pais)}), formato ${String(leer.data?.formato)}.`)
    if (map?.ok) {
      l.push(`- Campos llenos: ${etiquetas(map.data?.llenos).length} (${etiquetas(map.data?.llenos).join(", ")})`)
      l.push(`- Faltantes: ${etiquetas(map.data?.faltantes).join(", ") || "ninguno"}`)
      l.push(`- Requieren confirmación: ${(map.data?.requiere_confirmacion as Array<{ etiqueta: string; motivo: string }> | undefined)?.map((c) => `${c.etiqueta} (${c.motivo})`).join(", ") || "ninguno"}`)
    } else if (map) l.push(`- Mapeo: ${map.error ?? ""}`)
    if (gen) l.push(gen.ok ? `- Formulario: ${String(gen.data?.ruta)}${gen.data?.soportado === false ? " — formato no soportado; valores listos para copiar" : ""}` : `- Formulario: ${gen.error ?? ""}`)
    if (paq?.ok) {
      const sop = (paq.data?.checklist as { soportes?: Array<{ tipo: string; estado: string }> } | undefined)?.soportes ?? []
      l.push(`- Paquete: ${String(paq.data?.ruta)} · **listo_para_firma: ${paq.data?.listo_para_firma ? "sí" : "no"}**`)
      const actualizar = sop.filter((x) => x.estado !== "presente").map((x) => `${x.tipo} (${x.estado})`)
      l.push(`- Soportes a actualizar: ${actualizar.join(", ") || "ninguno"}`)
    } else if (paq) l.push(`- Paquete: ${paq.error ?? ""}`)
    l.push("", "No he enviado nada. ¿Quieres que prepare el envío simulado? Si es así, escribe **envía** y luego confirma en el recuadro resaltado.")
    return l.join("\n")
  }
}
