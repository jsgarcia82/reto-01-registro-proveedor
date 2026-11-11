import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }
export const ok = <T>(data: T): Result<T> => ({ ok: true, data })
export const fail = <T = never>(error: string): Result<T> => ({ ok: false, error })
/** Error con datos adicionales no sensibles (p. ej. estado de la confirmación pendiente). */
export const failCon = <T = never>(error: string, extra: Record<string, unknown>): Result<T> => ({ ...extra, ok: false, error }) as Result<T>

/** Error de negocio con mensaje apto para el usuario (nunca una traza cruda). */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string = "dominio",
  ) {
    super(message)
  }
}

export interface Clock {
  now(): Date
  /** Fecha de referencia (YYYY-MM-DD) para vigencias de soportes. */
  today(): string
}

export function systemClock(asOfDate?: string): Clock {
  return {
    now: () => new Date(),
    today: () => asOfDate ?? new Date().toISOString().slice(0, 10),
  }
}

export interface FixedClock extends Clock {
  advance(ms: number): void
}

/** Reloj controlable para pruebas y demo (determinismo). */
export function fixedClock(isoNow: string, asOfDate?: string): FixedClock {
  let current = new Date(isoNow)
  return {
    now: () => current,
    today: () => asOfDate ?? current.toISOString().slice(0, 10),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

/** Normaliza etiquetas: sin acentos, minúsculas, espacios simples. */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/** JSON canónico (claves ordenadas) para hashes estables. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex")
export const hashCanonical = (value: unknown): string => sha256(canonicalJson(value))
export const sha256File = async (path: string): Promise<string> => sha256(await readFile(path))

export function errorMessage(err: unknown): string {
  if (err instanceof DomainError) return err.message
  return "Error interno inesperado; quedó registrado para revisión."
}
