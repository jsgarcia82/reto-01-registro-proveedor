import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { evaluarSoportes } from "../src/domain/checklist.js"
import { cargarIndiceSoportes, verificarChecksums } from "../src/domain/fixtures.js"
import { confirmarEnvio } from "../src/services/confirmations.js"
import { herramientas } from "../src/tools/proveedor.js"
import { copiaFixtures, entorno, type Entorno, FIXTURES, pedirConfirmacion, procesar, ROOT, tool } from "./helpers.js"

const etq = (xs: Array<{ etiqueta: string }>) => xs.map((x) => x.etiqueta)

describe("HU-1/HU-2 — lectura y mapeo (fidelidad a los 4 casos)", () => {
  let e: Entorno
  beforeAll(async () => (e = await entorno({ asOf: "2026-08-25" })))
  afterAll(() => e.limpiar())

  it.each([
    ["co-industrias-delta", "CO", "xlsx", 17, [], []],
    ["ec-corp-andina", "EC", "pdf", 13, ["Número de contribuyente especial"], ["RUC"]],
    ["hn-agroexport-sula", "HN", "xlsx", 9, ["Referencias comerciales"], ["RTN"]],
    ["pa-logistica-istmo", "PA", "portal", 8, [], ["RUC"]],
  ])("%s → país %s, formato %s, %i llenos, faltantes %j, por confirmar %j", async (caso, pais, formato, llenos, faltantes, confirmar) => {
    const { leer, mapeo } = await procesar(caso, e.ctx(e.a.id, e.sesionA))
    expect(leer.data).toMatchObject({ pais, formato })
    expect(mapeo.data.llenos).toHaveLength(llenos)
    expect(etq(mapeo.data.faltantes)).toEqual(faltantes)
    expect(etq(mapeo.data.requiere_confirmacion)).toEqual(confirmar)
    for (const c of mapeo.data.llenos) expect(c.ruta).toBeTruthy() // trazabilidad: ruta del dato en el maestro
  })

  it("RN1: identificador extranjero se llena con el NIT y queda requiere_confirmacion con la nota", async () => {
    const { mapeo, leer } = await procesar("hn-agroexport-sula", e.ctx(e.a.id, e.sesionA))
    expect(leer.data.identificador_tributario_pais).toBe("RTN")
    expect(leer.data.requiere_confirmacion[0]).toMatchObject({ etiqueta: "RTN", motivo: "identificador extranjero" })
    expect(mapeo.data.requiere_confirmacion[0]).toMatchObject({ etiqueta: "RTN", ruta: "nit", valor: "900123456", motivo: "identificador extranjero" })
  })

  it("no se inventan campos: etiquetas que no están en la plantilla se rechazan", async () => {
    await tool("leer_solicitud", { caso: "co-industrias-delta" }, e.ctx(e.a.id, e.sesionA))
    const r = await tool("mapear_campos", { caso: "co-industrias-delta", campos: ["Razón social", "Patrimonio neto"] }, e.ctx(e.a.id, e.sesionA))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Patrimonio neto/)
  })

  it("generar_formulario solo acepta el mapeo vigente del servidor (el modelo no puede inyectar valores)", async () => {
    const r = await tool("generar_formulario", { caso: "co-industrias-delta", mapeo: "f".repeat(64) }, e.ctx(e.a.id, e.sesionA))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no es el vigente/)
  })

  it("P2 portal: formato no soportado + valores-portal.md, sin credenciales", async () => {
    const { gen } = await procesar("pa-logistica-istmo", e.ctx(e.a.id, e.sesionA))
    expect(gen.data).toMatchObject({ formato: "portal", soportado: false })
    expect(gen.data.aviso).toMatch(/formato no soportado/)
    const md = await readFile(join(e.paths.out, "pa-logistica-istmo", "valores-portal.md"), "utf8")
    expect(md).toContain("Logística del Istmo")
    expect(md).toMatch(/credenciales del portal las ingresa una persona/)
  })
})

describe("HU-4 / RN3 — paquete y vigencias", () => {
  let e: Entorno
  afterEach(() => e.limpiar())

  it("vencido y ausente bloquean listo_para_firma; faltante no bloquea pero aparece en el checklist", async () => {
    e = await entorno({ asOf: "2026-08-29" })
    const hn = await procesar("hn-agroexport-sula", e.ctx(e.a.id, e.sesionA))
    expect(hn.paq.data.listo_para_firma).toBe(true) // tiene faltante "Referencias comerciales" y aun así está listo
    expect(await readFile(join(e.paths.out, "hn-agroexport-sula", "paquete", "checklist.md"), "utf8")).toContain("Referencias comerciales")
    const ec = await procesar("ec-corp-andina", e.ctx(e.a.id, e.sesionA))
    expect(ec.paq.data.listo_para_firma).toBe(false)
    expect(ec.paq.data.bloqueos).toContain("Soporte exigido ausente: certificado_cumplimiento_tributario")
  })

  it("con la fecha de ejecución 2026-11-10 la cámara de comercio y parafiscales están vencidos", async () => {
    e = await entorno({ asOf: "2026-11-10" })
    const hn = await procesar("hn-agroexport-sula", e.ctx(e.a.id, e.sesionA))
    expect(hn.paq.data.listo_para_firma).toBe(false)
    expect(hn.paq.data.checklist.soportes).toEqual([
      { tipo: "camara_comercio", estado: "vencido", vigencia_hasta: "2026-09-30" },
      { tipo: "rut", estado: "presente", vigencia_hasta: null },
      { tipo: "parafiscales", estado: "vencido", vigencia_hasta: "2026-08-31" },
    ])
    const alertas = await e.db.query<{ codigo: string }>("SELECT codigo FROM alerts WHERE codigo = 'paquete_bloqueado'")
    expect(alertas.rows.length).toBe(2)
  })

  it("el paquete contiene formulario, soportes exigidos existentes, checklist y borrador", async () => {
    e = await entorno({ asOf: "2026-08-25" })
    await procesar("co-industrias-delta", e.ctx(e.a.id, e.sesionA))
    const d = join(e.paths.out, "co-industrias-delta", "paquete")
    for (const f of ["formulario.xlsx", "checklist.md", "borrador-correo.md", "soportes/camara-comercio-2026-08.txt", "soportes/rut-2026.txt", "soportes/certificacion-bancaria-2026-08.txt", "soportes/estados-financieros-2025.txt"])
      expect(existsSync(join(d, f)), f).toBe(true)
    expect(existsSync(join(d, "soportes", "iso-9001-2025.txt"))).toBe(false) // no exigido
  })

})

describe("RN3 — regla de vencimiento", () => {
  it("vigencia: el último día de vigencia todavía es válido", async () => {
    const indice = await cargarIndiceSoportes({ fixtures: FIXTURES, out: "" })
    expect(evaluarSoportes(["parafiscales"], indice, "2026-08-31").items[0]?.estado).toBe("presente")
    expect(evaluarSoportes(["parafiscales"], indice, "2026-09-01").items[0]?.estado).toBe("vencido")
  })
})

describe("HU-5 — errores claros, las herramientas nunca lanzan", () => {
  let e: Entorno
  afterEach(() => e.limpiar())

  it("caso inexistente y path traversal → mensaje claro con los casos disponibles", async () => {
    e = await entorno()
    for (const caso of ["no-existe", "../repositorio", "co-industrias-delta/../../x"]) {
      const r = await tool("leer_solicitud", { caso }, e.ctx(e.a.id, e.sesionA))
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/no existe/)
    }
  })

  it("argumentos inválidos o basura → {ok:false,error} sin excepción", async () => {
    e = await entorno()
    for (const [nombre, h] of Object.entries(herramientas)) {
      for (const args of [undefined, null, 42, "x", {}, { caso: 5 }, { caso: "co-industrias-delta", campos: "x", mapeo: 1, confirmado: "si" }]) {
        const raw = await h.execute(args, e.ctx(e.a.id, e.sesionA))
        const r = JSON.parse(raw) as { ok: boolean; error?: string }
        expect(typeof r.ok, `${nombre}(${JSON.stringify(args)})`).toBe("boolean")
        if (!r.ok) expect(r.error).not.toMatch(/at .*\.ts:\d+/) // sin traza cruda
      }
    }
  })

  it("plantilla corrupta: aviso claro y el flujo continúa con el checklist de soportes", async () => {
    const fx = await copiaFixtures()
    try {
      await writeFile(join(fx.dir, "casos", "co-industrias-delta", "plantilla-celdas.json"), "{ esto no es json")
      e = await entorno({ asOf: "2026-08-25", fixtures: fx.dir })
      const { leer, mapeo, paq } = await procesar("co-industrias-delta", e.ctx(e.a.id, e.sesionA))
      expect(leer.ok).toBe(true)
      expect(leer.data.advertencias.join(" ")).toMatch(/corrupta/)
      expect(mapeo.ok).toBe(false)
      expect(paq.ok).toBe(true)
      expect(paq.data.listo_para_firma).toBe(false)
      expect(paq.data.bloqueos).toContain("Formulario no generado")
      // un caso malo no impide el siguiente
      expect((await procesar("ec-corp-andina", e.ctx(e.a.id, e.sesionA))).paq.ok).toBe(true)
    } finally {
      await fx.limpiar()
    }
  })

  it("RN5: cada ejecución deja {ts, herramienta, ok, resumen} en out/<caso>/log.jsonl", async () => {
    e = await entorno()
    await procesar("ec-corp-andina", e.ctx(e.a.id, e.sesionA))
    const lineas = (await readFile(join(e.paths.out, "ec-corp-andina", "log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lineas.map((l) => l.herramienta)).toEqual(["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"])
    for (const l of lineas) expect(Object.keys(l)).toEqual(expect.arrayContaining(["ts", "herramienta", "ok", "resumen"]))
  })
})

describe("Fixtures de solo lectura", () => {
  it("CHECKSUMS.sha256 coincide antes y después de ejecutar todos los casos", async () => {
    expect(await verificarChecksums(join(ROOT, "fixtures"))).toEqual([])
    const e = await entorno({ asOf: "2026-08-25" })
    for (const caso of ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"]) await procesar(caso, e.ctx(e.a.id, e.sesionA))
    await e.limpiar()
    expect(await verificarChecksums(join(ROOT, "fixtures"))).toEqual([])
  })
})

describe("Disco efímero (Render Free): la BD conserva el estado pero out/ se borra", () => {
  let e: Entorno
  afterEach(() => e.limpiar())
  const caso = "ec-corp-andina"

  it("confirmar tras perder los archivos → mensaje claro (no error interno) y nada enviado", async () => {
    e = await entorno({ asOf: "2026-08-27" })
    await procesar(caso, e.ctx(e.a.id, e.sesionA))
    const p = await pedirConfirmacion(caso, e, e.a.id, e.sesionA)
    await rm(e.paths.out, { recursive: true, force: true })
    await expect(confirmarEnvio(e.services, { token: p.token, userId: e.a.id, userEmail: e.a.email })).rejects.toThrow(/ya no están en el servidor/)
    expect((await e.db.query("SELECT id FROM envios")).rows).toHaveLength(0)
  })

  it("pedir envío o rearmar sin archivos → mensaje claro; reprocesar el caso lo recupera", async () => {
    e = await entorno({ asOf: "2026-08-27" })
    await procesar(caso, e.ctx(e.a.id, e.sesionA))
    await rm(e.paths.out, { recursive: true, force: true })
    const envio = await tool("simular_envio", { caso, confirmado: true }, e.ctx(e.a.id, e.sesionA))
    expect(envio.error).toMatch(/ya no están en el servidor/)
    const paq = await tool("armar_paquete", { caso }, e.ctx(e.a.id, e.sesionA))
    expect(paq.ok).toBe(true)
    expect(paq.data.bloqueos).toContain("Formulario no disponible en el servidor; vuelve a generarlo")
    const again = await procesar(caso, e.ctx(e.a.id, e.sesionA))
    expect(again.gen.ok).toBe(true)
    expect(again.paq.data.bloqueos).not.toContain("Formulario no disponible en el servidor; vuelve a generarlo")
  })
})
