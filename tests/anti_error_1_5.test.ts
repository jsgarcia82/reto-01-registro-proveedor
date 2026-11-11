import ExcelJS from "exceljs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PDFDocument } from "pdf-lib"
import { leerCamposPdf, nombreCampoPdf } from "../src/docs/pdf.js"
import { copiaFixtures, entorno, type Entorno, FIXTURES, procesar } from "./helpers.js"

type Celda = { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }
type Snap = Map<string, { value: unknown; style: string }>

async function snapshot(path: string): Promise<{ hojas: string[]; celdas: Snap; anchos: Record<string, Array<number | undefined>>; merges: Record<string, unknown> }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const celdas: Snap = new Map()
  const anchos: Record<string, Array<number | undefined>> = {}
  const merges: Record<string, unknown> = {}
  wb.eachSheet((ws) => {
    anchos[ws.name] = Array.from({ length: 8 }, (_, i) => ws.getColumn(i + 1).width)
    merges[ws.name] = (ws.model as { merges?: unknown }).merges ?? []
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (c) => celdas.set(`${ws.name}!${c.address}`, { value: c.value, style: JSON.stringify(c.style) })),
    )
  })
  return { hojas: wb.worksheets.map((w) => w.name), celdas, anchos, merges }
}

/** La salida debe ser la plantilla + SOLO las celdas de valor: nada más cambia. */
function compararConPlantilla(base: Awaited<ReturnType<typeof snapshot>>, out: Awaited<ReturnType<typeof snapshot>>, celdas: Celda[]): void {
  const valor = new Set(celdas.map((c) => `${c.hoja}!${c.celda_valor}`))
  expect(out.hojas).toEqual(base.hojas)
  expect(out.anchos).toEqual(base.anchos)
  expect(out.merges).toEqual(base.merges)
  for (const [addr, b] of base.celdas) {
    if (valor.has(addr)) continue
    expect(out.celdas.get(addr), `celda ${addr} preservada`).toEqual(b)
  }
  for (const addr of out.celdas.keys()) expect(base.celdas.has(addr) || valor.has(addr), `celda extra ${addr}`).toBe(true)
}

describe("anti_error_1_5 — PDF/XLSX preservan la plantilla original", () => {
  let e: Entorno
  afterEach(() => e?.limpiar())

  it("XLSX (co-industrias-delta): formulario = plantilla base + celdas de valor; etiquetas y valores en la celda exacta", async () => {
    e = await entorno({ asOf: "2026-08-25" })
    const caso = "co-industrias-delta"
    const { gen } = await procesar(caso, e.ctx(e.a.id, e.sesionA))
    expect(gen.ok).toBe(true)
    const celdas = JSON.parse(await readFile(join(FIXTURES, "casos", caso, "plantilla-celdas.json"), "utf8")) as Celda[]
    const base = await snapshot(join(e.paths.out, caso, "plantilla-base.xlsx"))
    const out = await snapshot(join(e.paths.out, caso, "formulario.xlsx"))
    compararConPlantilla(base, out, celdas)
    for (const c of celdas) expect(out.celdas.get(`${c.hoja}!${c.celda_etiqueta}`)?.value).toBe(c.etiqueta)
    expect(out.celdas.get("Datos Proveedor!C4")?.value).toBe("900123456")
    expect(out.celdas.get("Datos Bancarios!C5")?.value).toBe("03100012345") // RN2: la plantilla lo pide explícitamente
  })

  it("XLSX con adjunto ORIGINAL del cliente (estilos, hoja extra, celdas combinadas): se carga y se rellena, no se regenera", async () => {
    const fx = await copiaFixtures()
    try {
      const caso = "co-industrias-delta"
      const celdas = JSON.parse(await readFile(join(fx.dir, "casos", caso, "plantilla-celdas.json"), "utf8")) as Celda[]
      const wb = new ExcelJS.Workbook()
      const ins = wb.addWorksheet("Instrucciones")
      ins.mergeCells("A1:D1")
      ins.getCell("A1").value = "Diligencie solo la columna C. Versión 3."
      ins.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE699" } }
      for (const c of celdas) {
        const ws = wb.getWorksheet(c.hoja) ?? wb.addWorksheet(c.hoja)
        ws.getCell("B1").value = "FORMATO DE PROVEEDORES v3 — Industrias Delta"
        ws.getCell("B1").font = { bold: true, size: 14, color: { argb: "FF1F4E79" } }
        ws.getColumn(2).width = 41
        ws.getColumn(3).width = 52
        ws.getCell(c.celda_etiqueta).value = c.etiqueta
        ws.getCell(c.celda_etiqueta).border = { bottom: { style: "thin" } }
        ws.getCell(c.celda_valor).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } }
      }
      const original = join(fx.dir, "casos", caso, "Formato_Proveedores_v3.xlsx")
      await wb.xlsx.writeFile(original)

      e = await entorno({ asOf: "2026-08-25", fixtures: fx.dir })
      const { leer, gen } = await procesar(caso, e.ctx(e.a.id, e.sesionA))
      expect(leer.data.advertencias.join(" ")).not.toMatch(/no incluidos/)
      expect(gen.data.origen_plantilla).toBe("adjunto_original")
      const base = await snapshot(original)
      const out = await snapshot(join(e.paths.out, caso, "formulario.xlsx"))
      // los estilos de la celda de valor (relleno gris) también se conservan
      const outWb = new ExcelJS.Workbook()
      await outWb.xlsx.readFile(join(e.paths.out, caso, "formulario.xlsx"))
      expect(JSON.stringify(outWb.getWorksheet("Datos Proveedor")?.getCell("C3").fill)).toContain("FFEFEFEF")
      compararConPlantilla(base, out, celdas)
    } finally {
      await fx.limpiar()
    }
  })

  it("XLSX: si la plantilla del cliente no coincide con plantilla-celdas.json, no se escribe nada", async () => {
    const fx = await copiaFixtures()
    try {
      const caso = "hn-agroexport-sula"
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet("Registro").getCell("A2").value = "Otra cosa"
      await wb.xlsx.writeFile(join(fx.dir, "casos", caso, "Registro_Proveedor_Extranjero.xlsx"))
      e = await entorno({ asOf: "2026-08-29", fixtures: fx.dir })
      const { gen } = await procesar(caso, e.ctx(e.a.id, e.sesionA))
      expect(gen.ok).toBe(false)
      expect(gen.error).toMatch(/no coincide/)
    } finally {
      await fx.limpiar()
    }
  })

  it("PDF (ec-corp-andina): mismos campos y orden que la plantilla; solo cambian los valores", async () => {
    e = await entorno({ asOf: "2026-08-27" })
    const caso = "ec-corp-andina"
    const { gen } = await procesar(caso, e.ctx(e.a.id, e.sesionA))
    expect(gen.ok).toBe(true)
    const campos = JSON.parse(await readFile(join(FIXTURES, "casos", caso, "plantilla-campos.json"), "utf8")) as Array<{ etiqueta: string }>
    const base = await readFile(join(e.paths.out, caso, "plantilla-base.pdf"))
    const out = await readFile(join(e.paths.out, caso, "formulario.pdf"))
    const fb = await leerCamposPdf(base)
    const fo = await leerCamposPdf(out)
    expect(fo.map((f) => f.nombre)).toEqual(fb.map((f) => f.nombre))
    expect(fo.map((f) => f.nombre)).toEqual(campos.map((_, i) => nombreCampoPdf(i)))
    expect((await PDFDocument.load(out)).getPageCount()).toBe((await PDFDocument.load(base)).getPageCount())
    const val = (et: string) => fo[campos.findIndex((c) => c.etiqueta === et)]?.valor
    expect(val("Nombre de la empresa")).toBe("Periferia IT Group S.A.S.")
    expect(val("RUC")).toBe("900123456")
    expect(val("Número de contribuyente especial")).toBe("") // faltante: nunca se inventa
  })

  it("PDF con adjunto ORIGINAL (AcroForm con campos por etiqueta): se rellena sobre el original", async () => {
    const fx = await copiaFixtures()
    try {
      const caso = "ec-corp-andina"
      const campos = JSON.parse(await readFile(join(fx.dir, "casos", caso, "plantilla-campos.json"), "utf8")) as Array<{ etiqueta: string }>
      const pdfPath = join(fx.dir, "casos", caso, "Formulario_Calificacion_2026.pdf")
      const { writeFile } = await import("node:fs/promises")
      // se usan las etiquetas exactas como nombres de campo
      const doc2 = await PDFDocument.create()
      const p2 = doc2.addPage([612, 1100])
      const f2 = doc2.getForm()
      campos.forEach((c, i) => f2.createTextField(c.etiqueta).addToPage(p2, { x: 300, y: 1000 - i * 50, width: 250, height: 18 }))
      await writeFile(pdfPath, await doc2.save())
      e = await entorno({ asOf: "2026-08-27", fixtures: fx.dir })
      const { gen } = await procesar(caso, e.ctx(e.a.id, e.sesionA))
      expect(gen.ok).toBe(true)
      expect(gen.data.origen_plantilla).toBe("adjunto_original")
      const fo = await leerCamposPdf(await readFile(join(e.paths.out, caso, "formulario.pdf")))
      expect(fo.map((f) => f.nombre)).toEqual(campos.map((c) => c.etiqueta))
      expect(fo.find((f) => f.nombre === "Ciudad")?.valor).toBe("Medellín")
    } finally {
      await fx.limpiar()
    }
  })
})
