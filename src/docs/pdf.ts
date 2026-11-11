import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { DomainError } from "../domain/core.js"
import type { CampoPdf } from "../domain/fixtures.js"

export const nombreCampoPdf = (i: number): string => `campo_${String(i + 1).padStart(2, "0")}`

/**
 * Plantilla base PDF (AcroForm). Si el cliente adjuntó el PDF original se CARGA.
 * Si no, se deriva de plantilla-campos.json: una etiqueta visible + un campo de texto por fila, en orden.
 */
export async function cargarPlantillaPdf(campos: CampoPdf[], titulo: string, original: string | null): Promise<{ bytes: Uint8Array; origen: "adjunto_original" | "derivada_de_plantilla_campos" }> {
  if (original && existsSync(original)) return { bytes: new Uint8Array(await readFile(original)), origen: "adjunto_original" }
  const doc = await PDFDocument.create()
  doc.setTitle(titulo)
  doc.setProducer("reto-01-registro-proveedor")
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"))
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const form = doc.getForm()
  let page = doc.addPage([595, 842])
  page.drawText(titulo, { x: 40, y: 800, size: 14, font: bold })
  let y = 760
  campos.forEach((c, i) => {
    if (y < 60) {
      page = doc.addPage([595, 842])
      y = 800
    }
    page.drawText(`${c.etiqueta}${c.obligatorio ? " *" : ""}`, { x: 40, y: y + 6, size: 9, font: bold, color: rgb(0.1, 0.1, 0.1) })
    const tf = form.createTextField(nombreCampoPdf(i))
    tf.addToPage(page, { x: 250, y, width: 305, height: 20, font, borderWidth: 1 })
    y -= 34
  })
  page.drawText("* obligatorio", { x: 40, y: 30, size: 8, font })
  return { bytes: await doc.save({ useObjectStreams: false }), origen: "derivada_de_plantilla_campos" }
}

/** Rellena los campos del AcroForm (por nombre de etiqueta o campo_NN). No regenera el documento. */
export async function rellenarPdf(base: Uint8Array, campos: CampoPdf[], valores: Array<string | number | null>): Promise<{ bytes: Uint8Array; escritas: number; vacias: number }> {
  const doc = await PDFDocument.load(base)
  const form = doc.getForm()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const nombres = new Set(form.getFields().map((f) => f.getName()))
  let escritas = 0
  campos.forEach((c, i) => {
    const nombre = nombres.has(c.etiqueta) ? c.etiqueta : nombreCampoPdf(i)
    if (!nombres.has(nombre)) throw new DomainError(`La plantilla PDF no tiene el campo "${c.etiqueta}".`, "plantilla_incompatible")
    const v = valores[i] ?? null
    const tf = form.getTextField(nombre)
    if (v !== null) {
      tf.setText(String(v))
      escritas++
    }
    tf.enableReadOnly()
  })
  form.updateFieldAppearances(font)
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"))
  return { bytes: await doc.save({ useObjectStreams: false }), escritas, vacias: campos.length - escritas }
}

/** Lectura para verificación (pruebas y demo): pares nombre→valor en orden. */
export async function leerCamposPdf(bytes: Uint8Array): Promise<Array<{ nombre: string; valor: string }>> {
  const doc = await PDFDocument.load(bytes)
  return doc
    .getForm()
    .getFields()
    .map((f) => ({ nombre: f.getName(), valor: doc.getForm().getTextField(f.getName()).getText() ?? "" }))
}
