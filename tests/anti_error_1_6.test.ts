import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ejecutarTurno } from "../src/agent/loop.js"
import { loadConfig } from "../src/config.js"
import { cargarMaestro } from "../src/domain/fixtures.js"
import { valoresSensibles } from "../src/domain/privacy.js"
import type { ChatMessage, LlmAdapter } from "../src/llm/adapter.js"
import { AnthropicAdapter, type AnthropicLikeClient, type AnthropicRequest, type AnthropicResponse } from "../src/llm/anthropic.js"
import { MockLlm } from "../src/llm/mock.js"
import { PrivacyGuardAdapter } from "../src/llm/privacy-guard.js"
import { construirApp } from "../src/server.js"
import { entorno, type Entorno, FIXTURES, procesar, ROOT, SENSIBLES } from "./helpers.js"

const CASOS = ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"]

/**
 * Cliente Anthropic ESPÍA: registra cada request que saldría por la red y responde como lo haría el modelo,
 * pidiendo herramientas en orden (usa MockLlm como "cerebro" sobre el formato Anthropic).
 */
class ClienteEspia implements AnthropicLikeClient {
  readonly requests: string[] = []
  private readonly cerebro = new MockLlm(CASOS)
  messages = {
    create: async (req: AnthropicRequest): Promise<AnthropicResponse> => {
      this.requests.push(JSON.stringify(req))
      // Reconvierte al formato neutral para decidir el siguiente paso.
      const neutral = req.messages.flatMap((m): ChatMessage[] => {
        if (typeof m.content === "string") return [{ role: "user" as const, content: m.content }]
        if (m.role === "assistant") {
          const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("")
          const toolCalls = m.content.filter((b) => b.type === "tool_use").map((b) => b as { id: string; name: string; input: unknown }).map((b) => ({ id: b.id, name: b.name, args: b.input }))
          return [{ role: "assistant" as const, content: text, toolCalls }]
        }
        return m.content.filter((b) => b.type === "tool_result").map((b) => {
          const r = b as { tool_use_id: string; content: string }
          const prev = req.messages.flatMap((x) => (Array.isArray(x.content) ? x.content : [])).find((y) => y.type === "tool_use" && (y as { id: string }).id === r.tool_use_id) as { name: string } | undefined
          return { role: "tool" as const, toolCallId: r.tool_use_id, name: prev?.name ?? "", content: r.content }
        })
      })
      const out = await this.cerebro.enviar(req.system, neutral, [])
      return {
        content: out.toolCalls.length ? out.toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.args })) : [{ type: "text", text: out.text }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }
    },
  }
}

describe("anti_error_1_6 — los datos bancarios y personales nunca llegan al LLM", () => {
  let e: Entorno
  afterEach(() => e.limpiar())

  it("espía en el cliente Anthropic: los 4 casos + envío, y el usuario pega su cuenta → 0 datos sensibles en las peticiones", async () => {
    e = await entorno({ asOf: "2026-08-25" })
    const espia = new ClienteEspia()
    const sensibles = valoresSensibles(await cargarMaestro(e.paths))
    const llm: LlmAdapter = new PrivacyGuardAdapter(new AnthropicAdapter("modelo-prueba", espia), sensibles)
    const deps = { services: e.services, llm, directory: ROOT, maxIterations: 25, maxTokensPerSession: 1_000_000 }
    for (const caso of CASOS) {
      const r = await ejecutarTurno(deps, { sessionId: e.sesionA, userId: e.a.id, message: `Procesa el caso "${caso}". No envíes nada todavía.` })
      expect(r.toolCalls.map((t) => t.nombre)).toContain("proveedor_armar_paquete")
    }
    await ejecutarTurno(deps, { sessionId: e.sesionA, userId: e.a.id, message: "envía el caso pa-logistica-istmo" })
    await ejecutarTurno(deps, { sessionId: e.sesionA, userId: e.a.id, message: "Por cierto, nuestra cuenta es 03100012345, SWIFT COLOCOBM y la cédula 71555123" })
    expect(espia.requests.length).toBeGreaterThan(15)
    const todo = espia.requests.join("\n")
    for (const s of SENSIBLES) expect(todo, `no debe salir ${s}`).not.toContain(s)
    expect(todo).toContain("[PROTEGIDO:banco.numero_cuenta]")
  })

  it("las salidas de herramientas solo contienen marcadores, pero el formulario sí lleva el dato real (RN2)", async () => {
    e = await entorno({ asOf: "2026-08-27" })
    const { mapeo } = await procesar("ec-corp-andina", e.ctx(e.a.id, e.sesionA))
    const txt = JSON.stringify(mapeo)
    for (const s of SENSIBLES) expect(txt).not.toContain(s)
    const cuenta = mapeo.data.llenos.find((c: { etiqueta: string }) => c.etiqueta === "Número de cuenta")
    expect(cuenta.valor).toBe("[PROTEGIDO:banco.numero_cuenta]")
  })

  it("RN2: el borrador de correo, el checklist y los logs nunca contienen datos bancarios", async () => {
    e = await entorno({ asOf: "2026-08-25" })
    for (const caso of CASOS) await procesar(caso, e.ctx(e.a.id, e.sesionA))
    for (const caso of CASOS) {
      for (const f of ["paquete/borrador-correo.md", "paquete/checklist.md", "log.jsonl"]) {
        const t = await readFile(join(e.paths.out, caso, f), "utf8")
        for (const s of SENSIBLES) expect(t, `${caso}/${f}`).not.toContain(s)
      }
    }
    const global = await readFile(join(e.paths.out, "log.jsonl"), "utf8")
    for (const s of SENSIBLES) expect(global).not.toContain(s)
  })

  it("health y API nunca exponen la clave del proveedor", async () => {
    e = await entorno()
    const config = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-clave-de-prueba-no-real", LLM_PROVIDER: "mock" })
    const { app } = await construirApp({ directory: ROOT, config, db: e.db, paths: { fixtures: FIXTURES, out: e.paths.out } })
    const r = await app.inject({ method: "GET", url: "/api/health" })
    expect(r.json()).toMatchObject({ ok: true, provider: "mock" })
    expect(r.body).not.toContain("sk-ant")
    await app.close()
  })
})
