import { ejecutarTurno } from "../src/agent/loop.js"
import type { ChatMessage, LlmAdapter, LlmResponse } from "../src/llm/adapter.js"
import { ConflictError, obtenerRun, transicionar } from "../src/services/runs.js"
import { entorno, type Entorno, procesar, ROOT, tool } from "./helpers.js"

/** anti_error_1_4: sin carreras entre sesiones (bloqueo optimista, UNIQUE y lease de sesión persistido). */
describe("anti_error_1_4 — carreras entre sesiones", () => {
  let e: Entorno
  const caso = "ec-corp-andina"
  beforeEach(async () => (e = await entorno({ asOf: "2026-08-27" })))
  afterEach(() => e.limpiar())

  it("dos sesiones con la misma versión leída: solo una transición gana (compare-and-set)", async () => {
    await tool("leer_solicitud", { caso }, e.ctx(e.a.id, e.sesionA))
    const leido = await obtenerRun(e.db, caso)
    if (!leido) throw new Error("sin run")
    const r = await Promise.allSettled([
      transicionar(e.services, { run: leido, userId: e.a.id, hacia: "mapeado", patch: { mapping_hash: "a".repeat(64) } }),
      transicionar(e.services, { run: leido, userId: e.a.id, hacia: "mapeado", patch: { mapping_hash: "b".repeat(64) } }),
    ])
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1)
    const rechazo = r.find((x) => x.status === "rejected") as PromiseRejectedResult
    expect(rechazo.reason).toBeInstanceOf(ConflictError)
    expect((await obtenerRun(e.db, caso))?.version).toBe(leido.version + 1)
  })

  it("herramientas concurrentes desde dos sesiones: sin actualizaciones perdidas y conflicto explicado", async () => {
    await procesar(caso, e.ctx(e.a.id, e.sesionA))
    const v0 = (await obtenerRun(e.db, caso))?.version ?? 0
    const rs = await Promise.all([
      tool("armar_paquete", { caso }, e.ctx(e.a.id, e.sesionA)),
      tool("armar_paquete", { caso }, e.ctx(e.a.id, e.sesionA2)),
      tool("armar_paquete", { caso }, e.ctx(e.a.id, e.sesionA)),
    ])
    const exitos = rs.filter((r) => r.ok).length
    expect(exitos).toBeGreaterThanOrEqual(1)
    for (const r of rs.filter((x) => !x.ok)) expect(r.error).toMatch(/Conflicto de concurrencia/)
    expect((await obtenerRun(e.db, caso))?.version).toBe(v0 + exitos)
  })

  it("dos usuarios abren el mismo caso a la vez: un solo dueño (UNIQUE), el otro recibe error claro", async () => {
    const [ra, rb] = await Promise.all([tool("leer_solicitud", { caso }, e.ctx(e.a.id, e.sesionA)), tool("leer_solicitud", { caso }, e.ctx(e.b.id, e.sesionB))])
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1)
    expect([ra, rb].find((r) => !r.ok)?.error).toMatch(/asignado a otro usuario/)
    expect((await e.db.query("SELECT id FROM runs WHERE caso = $1", [caso])).rows).toHaveLength(1)
  })

  it("el usuario B no puede operar el caso del usuario A", async () => {
    await procesar(caso, e.ctx(e.a.id, e.sesionA))
    const r = await tool("simular_envio", { caso, confirmado: true }, e.ctx(e.b.id, e.sesionB))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/asignado a otro usuario/)
  })

  it("dos mensajes simultáneos en la MISMA sesión: el segundo se rechaza (lease en BD, sin estado en memoria)", async () => {
    let liberar: () => void = () => undefined
    const espera = new Promise<void>((r) => (liberar = r))
    const lento: LlmAdapter = {
      provider: "test",
      model: "lento",
      async enviar(_s: string, _m: ChatMessage[]): Promise<LlmResponse> {
        await espera
        return { text: "hecho", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const deps = { services: e.services, llm: lento, directory: ROOT, maxIterations: 5, maxTokensPerSession: 1000 }
    const t1 = ejecutarTurno(deps, { sessionId: e.sesionA, userId: e.a.id, message: "hola" })
    await new Promise((r) => setTimeout(r, 50))
    await expect(ejecutarTurno(deps, { sessionId: e.sesionA, userId: e.a.id, message: "hola otra vez" })).rejects.toThrow(/procesando otro mensaje/)
    liberar()
    await expect(t1).resolves.toMatchObject({ reply: "hecho" })
    await expect(ejecutarTurno(deps, { sessionId: e.sesionA, userId: e.a.id, message: "ya libre" })).resolves.toMatchObject({ reply: "hecho" })
  })
})
