import type { Soporte } from "./fixtures.js"

export type EstadoSoporte = "presente" | "ausente" | "vencido"

export interface ItemSoporte {
  tipo: string
  estado: EstadoSoporte
  archivo: string | null
  vigencia_hasta: string | null
  descripcion: string | null
}

export interface EvaluacionSoportes {
  items: ItemSoporte[]
  /** RN3: vencido o ausente bloquea listo_para_firma. */
  bloqueos: string[]
}

/** HU-4 / RN3. asOf = fecha de ejecución (YYYY-MM-DD). Vencido si vigencia_hasta < asOf. */
export function evaluarSoportes(exigidos: string[], indice: Soporte[], asOf: string): EvaluacionSoportes {
  const items = exigidos.map((tipo): ItemSoporte => {
    const s = indice.find((x) => x.tipo === tipo)
    if (!s) return { tipo, estado: "ausente", archivo: null, vigencia_hasta: null, descripcion: null }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < asOf
    return { tipo, estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta, descripcion: s.descripcion ?? null }
  })
  const bloqueos = items
    .filter((i) => i.estado !== "presente")
    .map((i) => (i.estado === "ausente" ? `Soporte exigido ausente: ${i.tipo}` : `Soporte vencido: ${i.tipo} (vigencia ${i.vigencia_hasta})`))
  return { items, bloqueos }
}
