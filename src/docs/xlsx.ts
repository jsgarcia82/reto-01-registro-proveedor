import ExcelJS from "exceljs"
import { existsSync } from "node:fs"
import { DomainError } from "../domain/core.js"
import type { Celda } from "../domain/fixtures.js"

/**
 * Plantilla base: si el cliente adjuntó el .xlsx original, se CARGA tal cual.
 * Si el fixture no incluye el binario, se deriva una sola vez de plantilla-celdas.json
 * (etiquetas en celda_etiqueta) y se guarda como plantilla-base.xlsx para trazabilidad.
 */
export async function cargarPlantillaXlsx(celdas: Celda[], original: string | null): Promise<{ wb: ExcelJS.Workbook; origen: "adjunto_original" | "derivada_de_plantilla_celdas" }> {
  const wb = new ExcelJS.Workbook()
  if (original && existsSync(original)) {
    await wb.xlsx.readFile(original)
    return { wb, origen: "adjunto_original" }
  }
  for (const c of celdas) {
    const ws = wb.getWorksheet(c.hoja) ?? wb.addWorksheet(c.hoja)
    const cell = ws.getCell(c.celda_etiqueta)
    cell.value = c.etiqueta
    cell.font = { bold: true }
    ws.getColumn(cell.col).width = 38
    ws.getColumn(ws.getCell(c.celda_valor).col).width = 48
  }
  return { wb, origen: "derivada_de_plantilla_celdas" }
}

/** Antes de escribir: la plantilla debe contener cada hoja y cada etiqueta en su celda. */
export function validarPlantillaXlsx(wb: ExcelJS.Workbook, celdas: Celda[]): string[] {
  const errores: string[] = []
  for (const c of celdas) {
    const ws = wb.getWorksheet(c.hoja)
    if (!ws) {
      errores.push(`Falta la hoja "${c.hoja}"`)
      continue
    }
    const actual = String(ws.getCell(c.celda_etiqueta).value ?? "").trim()
    if (actual !== c.etiqueta.trim()) errores.push(`Hoja "${c.hoja}" celda ${c.celda_etiqueta}: se esperaba "${c.etiqueta}" y hay "${actual}"`)
  }
  return errores
}

/** Rellena SOLO las celdas de valor; no toca estilos, hojas ni otras celdas. */
export async function rellenarXlsx(wb: ExcelJS.Workbook, celdas: Celda[], valores: Array<string | number | null>): Promise<{ escritas: number; vacias: number }> {
  const errores = validarPlantillaXlsx(wb, celdas)
  if (errores.length) throw new DomainError(`La plantilla Excel no coincide con plantilla-celdas.json: ${errores.join("; ")}`, "plantilla_incompatible")
  let escritas = 0
  celdas.forEach((c, i) => {
    const v = valores[i] ?? null
    if (v === null) return
    const ws = wb.getWorksheet(c.hoja)
    if (!ws) return
    ws.getCell(c.celda_valor).value = v
    escritas++
  })
  return { escritas, vacias: celdas.length - escritas }
}

export async function xlsxBuffer(wb: ExcelJS.Workbook): Promise<Uint8Array> {
  return new Uint8Array(await wb.xlsx.writeBuffer())
}
