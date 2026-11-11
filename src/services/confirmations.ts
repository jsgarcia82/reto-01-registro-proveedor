import { randomBytes, randomUUID } from "node:crypto"
import { join } from "node:path"
import { DomainError, hashCanonical, sha256 } from "../domain/core.js"
import { hashDirectorio, writeAtomic } from "../docs/files.js"
import { registrarAlerta, registrarAuditoria } from "./audit.js"
import type { PendingConfirmation, Services } from "./context.js"
import { obtenerRun, type Run, transicionar } from "./runs.js"

export interface PayloadPaquete {
  caso: string
  as_of: string
  listo_para_firma: boolean
  bloqueos: string[]
  archivos: Record<string, string> // ruta relativa en paquete/ → sha256
}

export const hashPayload = (p: PayloadPaquete): string => hashCanonical(p)

/**
 * HITL: emite un token de un solo uso ligado a (run, versión, payload_hash, usuario, sesión, expiración).
 * Se guarda solo el hash del token. El estado pasa a confirmacion_pendiente (versión+1) y el token se liga a esa versión.
 */
export async function solicitarConfirmacion(s: Services, p: { run: Run; userId: string; sessionId: string }): Promise<PendingConfirmation> {
  if (!p.run.payload_hash) throw new DomainError("El paquete no está armado; ejecuta proveedor_armar_paquete primero.", "sin_paquete")
  const token = randomBytes(32).toString("base64url")
  const confirmationId = randomUUID()
  const expiresAt = new Date(s.clock.now().getTime() + s.config.confirmationTtlSeconds * 1000).toISOString()
  const payload = p.run.payload as PayloadPaquete
  const { run } = await transicionar(s, { run: p.run, userId: p.userId, hacia: "confirmacion_pendiente" }, async (q, nuevo) => {
    // un solo token vigente por run: los anteriores quedan cancelados
    await q.query("UPDATE confirmations SET cancelled_at = $2 WHERE run_id = $1 AND consumed_at IS NULL AND cancelled_at IS NULL", [nuevo.id, s.clock.now().toISOString()])
    await q.query(
      "INSERT INTO confirmations (id, token_hash, run_id, user_id, session_id, run_version, payload_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [confirmationId, sha256(token), nuevo.id, p.userId, p.sessionId, nuevo.version, nuevo.payload_hash, expiresAt, s.clock.now().toISOString()],
    )
    await registrarAuditoria(s, { userId: p.userId, sessionId: p.sessionId, runId: nuevo.id, caso: nuevo.caso, evento: "confirmacion_solicitada", ok: true, resumen: `versión ${nuevo.version}, payload ${nuevo.payload_hash?.slice(0, 12)}` }, q)
  })
  return {
    confirmationId,
    token,
    caso: run.caso,
    version: run.version,
    payloadHash: run.payload_hash ?? "",
    expiresAt,
    listoParaFirma: payload.listo_para_firma,
    bloqueos: payload.bloqueos,
    resumen: payload.listo_para_firma
      ? `Envío simulado del paquete "${run.caso}" (listo para firma).`
      : `Envío simulado del paquete "${run.caso}" CON BLOQUEOS: ${payload.bloqueos.join("; ")}. Al confirmar asumes estos bloqueos.`,
  }
}

/** RN4: un mensaje nuevo del usuario invalida las confirmaciones pendientes de la sesión (debe ser el turno inmediato). */
export async function cancelarPendientesDeSesion(s: Services, sessionId: string): Promise<void> {
  await s.db.query("UPDATE confirmations SET cancelled_at = $2 WHERE session_id = $1 AND consumed_at IS NULL AND cancelled_at IS NULL", [sessionId, s.clock.now().toISOString()])
}

export interface ResultadoEnvio {
  ruta: string
  envioId: string
  repetido: boolean
  listoParaFirma: boolean
}

interface FilaConfirmacion {
  id: string
  run_id: string
  run_version: number
  payload_hash: string
  session_id: string
}

/**
 * Consumo atómico del token (compare-and-set) + CAS sobre la versión del run + verificación del payload en disco
 * + clave de idempotencia UNIQUE. Todo en UNA transacción: o se hace todo o nada.
 */
export async function confirmarEnvio(s: Services, p: { token: string; userId: string; userEmail: string }): Promise<ResultadoEnvio> {
  const now = s.clock.now().toISOString()
  try {
    return await s.db.tx(async (q) => {
      const c = await q.query<FilaConfirmacion>(
        `UPDATE confirmations SET consumed_at = $3
         WHERE token_hash = $1 AND user_id = $2 AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > $3
         RETURNING id, run_id, run_version, payload_hash, session_id`,
        [sha256(p.token), p.userId, now],
      )
      const conf = c.rows[0]
      if (!conf) throw new DomainError("Confirmación rechazada: el token es inválido, expiró, ya fue usado, fue reemplazado o pertenece a otro usuario.", "token_invalido")

      const r = await q.query<Run>("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [conf.run_id])
      const run = r.rows[0]
      if (!run || run.user_id !== p.userId) throw new DomainError("Confirmación rechazada: el caso no pertenece a este usuario.", "token_invalido")
      if (run.version !== conf.run_version || run.state !== "confirmacion_pendiente")
        throw new DomainError(`Confirmación rechazada: el caso cambió desde que se pidió la confirmación (versión ${conf.run_version} → ${run.version}).`, "version_obsoleta")
      if (run.payload_hash !== conf.payload_hash) throw new DomainError("Confirmación rechazada: el contenido del paquete cambió (hash distinto).", "hash_distinto")

      const payload = run.payload as PayloadPaquete
      const enDisco = await hashDirectorio(join(s.paths.out, run.caso, "paquete"))
      if (hashPayload({ ...payload, archivos: enDisco }) !== conf.payload_hash)
        throw new DomainError("Confirmación rechazada: los archivos del paquete en disco no coinciden con lo que se confirmó.", "hash_distinto")

      const idempotencyKey = `envio:${run.id}:${conf.payload_hash}`
      const ruta = `out/${run.caso}/ENVIO-SIMULADO.md`
      const envioId = randomUUID()
      const ins = await q.query<{ id: string }>(
        `INSERT INTO envios (id, run_id, user_id, confirmation_id, idempotency_key, payload_hash, listo_para_firma, ruta, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [envioId, run.id, p.userId, conf.id, idempotencyKey, conf.payload_hash, payload.listo_para_firma, ruta, now],
      )
      const upd = await q.query("UPDATE runs SET state = 'enviado', version = version + 1, updated_at = $3 WHERE id = $1 AND version = $2", [run.id, run.version, now])
      if (upd.rowCount !== 1) throw new DomainError("Conflicto de concurrencia al confirmar.", "conflicto")

      if (!ins.rows[0]) {
        const prev = await q.query<{ id: string }>("SELECT id FROM envios WHERE idempotency_key = $1", [idempotencyKey])
        await registrarAuditoria(s, { userId: p.userId, sessionId: conf.session_id, runId: run.id, caso: run.caso, evento: "envio_simulado", ok: true, resumen: "repetido: mismo payload ya enviado (idempotente)" }, q)
        return { ruta, envioId: prev.rows[0]?.id ?? "", repetido: true, listoParaFirma: payload.listo_para_firma }
      }

      const md = [
        "# ENVÍO SIMULADO",
        "",
        "> Ningún correo fue enviado. Este archivo registra la decisión humana.",
        "",
        `- Caso: ${run.caso}`,
        `- Envío: ${envioId}`,
        `- Confirmado por: ${p.userEmail}`,
        `- Fecha y hora: ${now}`,
        `- Confirmación: ${conf.id}`,
        `- Versión confirmada: ${conf.run_version}`,
        `- Hash del paquete (SHA-256): ${conf.payload_hash}`,
        `- Fecha de referencia de vigencias: ${payload.as_of}`,
        `- Listo para firma: ${payload.listo_para_firma ? "sí" : "NO"}`,
        ...(payload.bloqueos.length ? ["", "## Bloqueos asumidos explícitamente por quien confirmó", ...payload.bloqueos.map((b) => `- ${b}`)] : []),
        "",
        "## Archivos del paquete",
        ...Object.entries(payload.archivos).map(([f, h]) => `- paquete/${f} — ${h}`),
        "",
      ].join("\n")
      await writeAtomic(join(s.paths.out, run.caso, "ENVIO-SIMULADO.md"), md)
      await registrarAuditoria(s, { userId: p.userId, sessionId: conf.session_id, runId: run.id, caso: run.caso, evento: "envio_simulado", ok: true, resumen: `confirmado por usuario; payload ${conf.payload_hash.slice(0, 12)}` }, q)
      if (!payload.listo_para_firma)
        await registrarAlerta(s, p.userId, run.id, { severidad: "critica", codigo: "envio_con_bloqueos", mensaje: `Envío simulado de ${run.caso} confirmado con bloqueos: ${payload.bloqueos.join("; ")}` }, q)
      return { ruta, envioId, repetido: false, listoParaFirma: payload.listo_para_firma }
    })
  } catch (err) {
    if (err instanceof DomainError) {
      await registrarAuditoria(s, { userId: p.userId, sessionId: null, runId: null, caso: null, evento: "confirmacion_rechazada", ok: false, resumen: err.message })
      await registrarAlerta(s, p.userId, null, { severidad: "advertencia", codigo: err.code, mensaje: err.message })
    }
    throw err
  }
}

export { obtenerRun }
