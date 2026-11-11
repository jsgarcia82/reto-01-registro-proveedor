import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { confirmarEnvio } from "../src/services/confirmations.js"
import { entorno, type Entorno, pedirConfirmacion, procesar } from "./helpers.js"

/** anti_error_1_2: la confirmación es atómica (compare-and-set en una transacción) y de un solo uso. */
describe("anti_error_1_2 — confirmación atómica y de un solo uso", () => {
  let e: Entorno
  const caso = "hn-agroexport-sula"
  beforeEach(async () => {
    e = await entorno({ asOf: "2026-08-29" })
    await procesar(caso, e.ctx(e.a.id, e.sesionA))
  })
  afterEach(() => e.limpiar())

  it("dos confirmaciones simultáneas con el mismo token: exactamente una gana", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    const intentos = await Promise.allSettled(Array.from({ length: 5 }, () => confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })))
    expect(intentos.filter((x) => x.status === "fulfilled")).toHaveLength(1)
    expect(intentos.filter((x) => x.status === "rejected")).toHaveLength(4)
    const envios = await e.db.query("SELECT id FROM envios")
    expect(envios.rows).toHaveLength(1)
    const consumidas = await e.db.query("SELECT id FROM confirmations WHERE consumed_at IS NOT NULL")
    expect(consumidas.rows).toHaveLength(1)
  })

  it("si la validación falla a mitad de la transacción, no queda nada a medias (rollback)", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    // Forzamos una versión distinta: la transacción consume el token, detecta el cambio y debe revertir TODO.
    await e.db.query("UPDATE runs SET version = version + 1 WHERE caso = $1", [caso])
    await expect(confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })).rejects.toThrow()
    const c = await e.db.query<{ consumed_at: string | null }>("SELECT consumed_at FROM confirmations")
    expect(c.rows[0]?.consumed_at).toBeNull()
    expect((await e.db.query("SELECT id FROM envios")).rows).toHaveLength(0)
    const run = await e.db.query<{ state: string }>("SELECT state FROM runs WHERE caso = $1", [caso])
    expect(run.rows[0]?.state).toBe("confirmacion_pendiente")
  })

  it("el envío queda con trazabilidad completa: quién, versión, hash y archivos", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    await confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })
    const md = await readFile(join(e.paths.out, caso, "ENVIO-SIMULADO.md"), "utf8")
    expect(md).toContain(e.a.email)
    expect(md).toContain(p.payloadHash)
    expect(md).toContain(`Versión confirmada: ${p.version}`)
    const audit = await e.db.query<{ evento: string }>("SELECT evento FROM audit_log WHERE evento = 'envio_simulado'")
    expect(audit.rows).toHaveLength(1)
  })
})
