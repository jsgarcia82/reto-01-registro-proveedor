import { existsSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { cancelarPendientesDeSesion, confirmarEnvio } from "../src/services/confirmations.js"
import { entorno, type Entorno, pedirConfirmacion, procesar, tool } from "./helpers.js"

/** anti_error_1_1: la confirmación está ligada a hash del payload, versión, identidad y expiración. */
describe("anti_error_1_1 — confirmación ligada a hash, versión e identidad", () => {
  let e: Entorno
  const caso = "co-industrias-delta"
  beforeEach(async () => {
    e = await entorno({ asOf: "2026-08-25" })
    await procesar(caso, e.ctx(e.a.id, e.sesionA))
  })
  afterEach(() => e.limpiar())
  const envio = () => join(e.paths.out, caso, "ENVIO-SIMULADO.md")

  it("el modelo con confirmado=true NO ejecuta el envío: solo emite un token para el humano", async () => {
    const r = await tool("simular_envio", { caso, confirmado: true }, e.ctx(e.a.id, e.sesionA))
    expect(r.ok).toBe(false)
    expect(r.error).toBe("requiere confirmación explícita")
    expect(JSON.stringify(r)).not.toMatch(/token/i)
    expect(existsSync(envio())).toBe(false)
  })

  it("acepta la confirmación del mismo usuario con versión y hash vigentes", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    const r = await confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })
    expect(r.repetido).toBe(false)
    expect(existsSync(envio())).toBe(true)
  })

  it("rechaza el token si lo presenta otro usuario (identidad)", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    await expect(confirmarEnvio(e.services, { token: p.token, userId: e.b.id, userEmail: e.b.email })).rejects.toThrow(/rechazada/)
    expect(existsSync(envio())).toBe(false)
  })

  it("rechaza el token si el paquete se rearmó después (versión)", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    expect((await tool("armar_paquete", { caso }, e.ctx(e.a.id, e.sesionA2))).ok).toBe(true)
    await expect(confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })).rejects.toThrow(/cambió/)
    expect(existsSync(envio())).toBe(false)
  })

  it("rechaza el token si un archivo del paquete cambió en disco (hash del payload)", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    await appendFile(join(e.paths.out, caso, "paquete", "borrador-correo.md"), "\nlínea añadida fuera del flujo")
    await expect(confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })).rejects.toThrow(/no coinciden/)
    expect(existsSync(envio())).toBe(false)
  })

  it("rechaza el token expirado", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    e.clock.advance(601_000)
    await expect(confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })).rejects.toThrow(/rechazada/)
  })

  it("RN4: un mensaje nuevo en la sesión invalida la confirmación pendiente (solo vale el turno inmediato)", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    await cancelarPendientesDeSesion(e.services, e.sesionA)
    await expect(confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })).rejects.toThrow(/rechazada/)
  })

  it("un token nuevo reemplaza al anterior (un solo token vigente por caso)", async () => {
    const p1 = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    const p2 = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    await expect(confirmarEnvio(e.services, { token: p1.token, userId: e.a.id, userEmail: e.a.email })).rejects.toThrow(/rechazada/)
    await expect(confirmarEnvio(e.services, { token: p2.token, userId: e.a.id, userEmail: e.a.email })).resolves.toMatchObject({ repetido: false })
  })

  it("solo se guarda el hash del token, nunca el token", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    const r = await e.db.query<{ token_hash: string }>("SELECT token_hash FROM confirmations")
    expect(r.rows.map((x) => x.token_hash)).not.toContain(p.token)
    expect(r.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/)
  })
})
