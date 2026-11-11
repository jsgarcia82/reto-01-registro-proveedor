import { randomUUID } from "node:crypto"
import { confirmarEnvio } from "../src/services/confirmations.js"
import { entorno, type Entorno, pedirConfirmacion, procesar, tool } from "./helpers.js"

/** Idempotencia distribuida: la clave vive en la BD (UNIQUE), no en memoria del proceso. */
describe("idempotencia distribuida del envío", () => {
  let e: Entorno
  const caso = "pa-logistica-istmo"
  beforeEach(async () => {
    e = await entorno({ asOf: "2026-09-01" })
    await procesar(caso, e.ctx(e.a.id, e.sesionA))
  })
  afterEach(() => e.limpiar())

  it("reprocesar con el mismo contenido y confirmar de nuevo NO duplica el envío (misma clave)", async () => {
    const p1 = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    expect((await confirmarEnvio(e.services, { token: p1.token, userId: e.a.id, userEmail: e.a.email })).repetido).toBe(false)
    const s = await tool("simular_envio", { caso, confirmado: true }, e.ctx(e.a.id, e.sesionA))
    expect(s).toMatchObject({ ok: true, data: { ya_enviado: true } })
    await procesar(caso, e.ctx(e.a.id, e.sesionA)) // mismo contenido → mismo payload_hash
    const p2 = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    expect(p2.payloadHash).toBe(p1.payloadHash)
    expect((await confirmarEnvio(e.services, { token: p2.token, userId: e.a.id, userEmail: e.a.email })).repetido).toBe(true)
    expect((await e.db.query("SELECT id FROM envios")).rows).toHaveLength(1)
  })

  it("la restricción UNIQUE rechaza una segunda inserción con la misma clave aunque venga de otro proceso", async () => {
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    await confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })
    const fila = (await e.db.query<{ run_id: string; idempotency_key: string; confirmation_id: string }>("SELECT run_id, idempotency_key, confirmation_id FROM envios")).rows[0]
    if (!fila) throw new Error("sin envío")
    const otraConf = randomUUID()
    await e.db.query("INSERT INTO confirmations (id, token_hash, run_id, user_id, session_id, run_version, payload_hash, expires_at) VALUES ($1,$2,$3,$4,$5,1,'x',now())", [otraConf, "h".repeat(64), fila.run_id, e.a.id, e.sesionA])
    await expect(
      e.db.query("INSERT INTO envios (id, run_id, user_id, confirmation_id, idempotency_key, payload_hash, listo_para_firma, ruta) VALUES ($1,$2,$3,$4,$5,'x',true,'r')", [randomUUID(), fila.run_id, e.a.id, otraConf, fila.idempotency_key]),
    ).rejects.toThrow(/unique|duplicate/i)
  })
})
