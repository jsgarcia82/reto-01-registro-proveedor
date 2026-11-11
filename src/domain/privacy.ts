import type { Maestro } from "./fixtures.js"
import { getPath, rutasHoja } from "./mapping.js"

/**
 * Minimización de datos hacia el LLM (anti_error_1_6).
 * Rutas sensibles: nunca viajan al modelo; se sustituyen por un marcador.
 */
export const RUTAS_SENSIBLES_PREFIJOS = ["banco."]
export const RUTAS_SENSIBLES_EXACTAS = ["representante_legal.identificacion"]

export const esRutaSensible = (ruta: string | null): boolean =>
  ruta !== null && (RUTAS_SENSIBLES_EXACTAS.includes(ruta) || RUTAS_SENSIBLES_PREFIJOS.some((p) => ruta.startsWith(p)))

export const marcador = (ruta: string): string => `[PROTEGIDO:${ruta}]`

/** Valor que puede ver el LLM para una ruta del maestro. */
export function valorParaLlm(ruta: string | null, maestro: Maestro): string | number | null {
  if (!ruta) return null
  if (esRutaSensible(ruta)) return marcador(ruta)
  const v = getPath(maestro, ruta)
  return typeof v === "string" || typeof v === "number" ? v : null
}

/**
 * Valores literales de alto riesgo (cuenta, SWIFT, cédula) para la guarda de texto libre.
 * Se excluyen valores públicos o genéricos (titular = razón social, moneda, tipo de cuenta).
 */
export function valoresSensibles(maestro: Maestro): Array<{ ruta: string; valor: string }> {
  const altoRiesgo = ["banco.numero_cuenta", "banco.swift", "representante_legal.identificacion"]
  return rutasHoja(maestro)
    .filter((r) => altoRiesgo.includes(r))
    .map((r) => ({ ruta: r, valor: String(getPath(maestro, r) ?? "") }))
    .filter((x) => x.valor.length >= 4)
}

/** Guarda de texto: reemplaza cualquier valor sensible literal por su marcador. */
export function redactarTexto(texto: string, sensibles: Array<{ ruta: string; valor: string }>): string {
  let out = texto
  for (const s of sensibles) out = out.split(s.valor).join(marcador(s.ruta))
  return out
}

export const contieneSensible = (texto: string, sensibles: Array<{ ruta: string; valor: string }>): boolean =>
  sensibles.some((s) => texto.includes(s.valor))
