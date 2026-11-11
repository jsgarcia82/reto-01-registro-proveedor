import type { AppConfig } from "../config.js"
import type { Db } from "../db/db.js"
import type { Clock } from "../domain/core.js"
import type { Paths } from "../domain/fixtures.js"

export interface Services {
  db: Db
  clock: Clock
  paths: Paths
  config: Pick<AppConfig, "confirmationTtlSeconds">
}

/** Confirmación pendiente: el token viaja SOLO al front, nunca al LLM. */
export interface PendingConfirmation {
  confirmationId: string
  token: string
  caso: string
  version: number
  payloadHash: string
  expiresAt: string
  listoParaFirma: boolean
  bloqueos: string[]
  resumen: string
}

/** Contexto que reciben las herramientas (superconjunto del contrato del PRD: directory + sessionId). */
export interface ToolContext {
  directory: string
  sessionId: string
  userId: string
  services: Services
  onConfirmationRequired?: (c: PendingConfirmation) => void
}
