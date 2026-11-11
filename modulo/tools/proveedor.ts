/**
 * Herramientas del agente empaquetadas para otras plataformas, SIN el servidor HTTP.
 * Son exactamente las mismas que usa la app (re-export, no copia). Nombre visto por el modelo: proveedor_<export>.
 */
import { join } from "node:path"
import { createDb } from "../../src/db/db.js"
import { systemClock } from "../../src/domain/core.js"
import type { ToolContext } from "../../src/services/context.js"
import { crearSesionChat, upsertUsuario } from "../../src/services/users.js"

export { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio } from "../../src/tools/proveedor.js"
export { confirmarEnvio } from "../../src/services/confirmations.js"

/**
 * Contexto listo para usar fuera del servidor: Postgres embebido (o DATABASE_URL), fixtures y out/ bajo `directory`.
 * La confirmación humana sigue siendo obligatoria: el token llega por `onConfirmationRequired` y se consume con confirmarEnvio.
 */
export async function crearContextoLocal(opts: { directory: string; usuario?: string; databaseUrl?: string; asOfDate?: string }): Promise<ToolContext> {
  const db = await createDb({ url: opts.databaseUrl })
  const user = await upsertUsuario(db, opts.usuario ?? "modulo@local", `modulo-${Date.now()}`)
  const sessionId = await crearSesionChat(db, user.id)
  return {
    directory: opts.directory,
    sessionId,
    userId: user.id,
    services: { db, clock: systemClock(opts.asOfDate), paths: { fixtures: join(opts.directory, "fixtures", "reto-01"), out: join(opts.directory, "out") }, config: { confirmationTtlSeconds: 600 } },
  }
}
