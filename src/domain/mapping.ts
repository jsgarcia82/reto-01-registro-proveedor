import { hashCanonical, normalizar } from "./core.js"
import type { CampoSolicitado, Glosario, Maestro } from "./fixtures.js"

export type EstadoCampo = "lleno" | "faltante" | "requiere_confirmacion"

export interface CampoMapeado {
  etiqueta: string
  estado: EstadoCampo
  /** Ruta del dato en el maestro (trazabilidad). null si no hay fuente. */
  ruta: string | null
  confianza: number
  origen: "glosario" | "similitud" | "ninguno"
  obligatorio: boolean | null
  motivo?: string
  propuesta?: string
}

/** RN1: identificador tributario por país. */
export const ID_TRIBUTARIO: Record<string, string> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }
const ETIQUETAS_TRIBUTARIAS_GENERICAS = ["identificacion tributaria", "numero de identificacion fiscal"]

const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "o", "y", "e", "en", "a", "para", "por"])
const tokens = (s: string): Set<string> =>
  new Set(normalizar(s).split(/[^a-z0-9]+/).filter((t) => t.length > 0 && !STOPWORDS.has(t)))

export function getPath(obj: unknown, ruta: string): unknown {
  return ruta.split(".").reduce<unknown>((acc, k) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj)
}

/** Rutas a valores escalares del maestro (para similitud). */
export function rutasHoja(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : []
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => rutasHoja(v, prefix ? `${prefix}.${k}` : k))
}

const tieneValor = (v: unknown): boolean =>
  v !== undefined && v !== null && (typeof v === "string" ? v.trim() !== "" : typeof v === "number" || typeof v === "boolean")

function similitud(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * HU-2: cada campo termina en lleno | faltante | requiere_confirmacion.
 * 100% determinista: glosario exacto → similitud léxica → faltante. Nunca inventa valores.
 */
export function mapearCampos(campos: CampoSolicitado[], pais: string, glosario: Glosario, maestro: Maestro): CampoMapeado[] {
  const glosarioNorm = new Map(Object.entries(glosario).map(([k, v]) => [normalizar(k), v]))
  const hojas = rutasHoja(maestro).map((r) => ({ ruta: r, tokens: tokens(r.replace(/[._]/g, " ")) }))

  return campos.map((c): CampoMapeado => {
    const base = { etiqueta: c.etiqueta, obligatorio: c.obligatorio }
    let ruta: string | null = glosarioNorm.get(normalizar(c.etiqueta)) ?? null
    let confianza = ruta ? 1 : 0
    let origen: CampoMapeado["origen"] = ruta ? "glosario" : "ninguno"

    if (!ruta) {
      const t = tokens(c.etiqueta)
      let best = { ruta: "", score: 0 }
      for (const h of hojas) {
        const s = similitud(t, h.tokens)
        if (s > best.score) best = { ruta: h.ruta, score: s }
      }
      if (best.score >= 0.5) {
        ruta = best.ruta
        confianza = Math.round(best.score * 100) / 100
        origen = "similitud"
      }
    }

    if (!ruta) return { ...base, estado: "faltante", ruta: null, confianza: 0, origen: "ninguno", motivo: "No existe en el repositorio maestro ni en el glosario." }
    if (!tieneValor(getPath(maestro, ruta))) return { ...base, estado: "faltante", ruta, confianza, origen, motivo: "La clave existe pero no tiene valor en el maestro." }

    if (ruta === "nit") {
      const idPais = ID_TRIBUTARIO[pais]
      if (!idPais) return { ...base, estado: "requiere_confirmacion", ruta, confianza, origen, motivo: `País ${pais} sin regla de identificador tributario.`, propuesta: "NIT" }
      if (pais !== "CO") return { ...base, estado: "requiere_confirmacion", ruta, confianza, origen, motivo: "identificador extranjero", propuesta: `${idPais}: se llena con el NIT colombiano` }
      if (ETIQUETAS_TRIBUTARIAS_GENERICAS.includes(normalizar(c.etiqueta))) return { ...base, estado: "requiere_confirmacion", ruta, confianza, origen, motivo: "Etiqueta tributaria ambigua.", propuesta: "NIT" }
    }
    if (confianza < 0.8) return { ...base, estado: "requiere_confirmacion", ruta, confianza, origen, motivo: `Mapeo por similitud con confianza ${confianza} (< 0.8).` }
    return { ...base, estado: "lleno", ruta, confianza, origen }
  })
}

export const hashMapeo = (mapeo: CampoMapeado[]): string => hashCanonical(mapeo)

/** Valor a escribir en el formulario: llenos y requiere_confirmacion (RN1) se llenan; faltantes quedan vacíos. */
export function valorParaFormulario(c: CampoMapeado, maestro: Maestro): string | number | null {
  if (c.estado === "faltante" || !c.ruta) return null
  const v = getPath(maestro, c.ruta)
  if (typeof v === "number") return v
  if (typeof v === "boolean") return v ? "Sí" : "No"
  return typeof v === "string" ? v : null
}
