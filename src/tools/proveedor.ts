import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { DomainError, errorMessage, fail, failCon, normalizar, ok, sha256, type Result } from "../domain/core.js"
import { evaluarSoportes } from "../domain/checklist.js"
import { cargarCaso, cargarGlosario, cargarIndiceSoportes, cargarMaestro, rutaSoporte } from "../domain/fixtures.js"
import { hashMapeo, ID_TRIBUTARIO, mapearCampos, valorParaFormulario, type CampoMapeado } from "../domain/mapping.js"
import { contieneSensible, valoresSensibles, valorParaLlm } from "../domain/privacy.js"
import { copyAtomic, hashDirectorio, resetDir, writeAtomic } from "../docs/files.js"
import { cargarPlantillaPdf, rellenarPdf } from "../docs/pdf.js"
import { cargarPlantillaXlsx, rellenarXlsx, xlsxBuffer } from "../docs/xlsx.js"
import { registrarAlerta, registrarAuditoria } from "../services/audit.js"
import { hashPayload, solicitarConfirmacion, type PayloadPaquete } from "../services/confirmations.js"
import type { ToolContext } from "../services/context.js"
import { asegurarRun, obtenerRunPropio, transicionar, type Run } from "../services/runs.js"

/**
 * Herramientas del agente. Contrato del PRD §6.2: { description, args (zod), execute(args, ctx) → string JSON }.
 * execute NUNCA lanza: devuelve {ok:true,data} | {ok:false,error}. Toda salida que ve el LLM pasa por la
 * política de privacidad (datos bancarios y cédula sustituidos por marcadores).
 */

type Shape = z.ZodRawShape
interface Definicion<A extends Shape, D> {
  nombre: string
  description: string
  args: A
  run(args: z.infer<z.ZodObject<A>>, ctx: ToolContext): Promise<Result<D>>
  resumir(data: D): string
}

export interface Herramienta<A extends Shape = Shape> {
  description: string
  args: A
  execute(args: unknown, ctx: ToolContext): Promise<string>
}

function definir<A extends Shape, D>(def: Definicion<A, D>): Herramienta<A> {
  const schema = z.object(def.args)
  return {
    description: def.description,
    args: def.args,
    async execute(rawArgs, ctx) {
      const parsed = schema.safeParse(rawArgs)
      let result: Result<D>
      if (!parsed.success) {
        result = fail(`Argumentos inválidos para proveedor_${def.nombre}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`)
      } else {
        try {
          result = await def.run(parsed.data, ctx)
        } catch (err) {
          if (!(err instanceof DomainError)) console.error(`[tool ${def.nombre}]`, err)
          result = fail(errorMessage(err))
        }
      }
      const caso = parsed.success && typeof (parsed.data as { caso?: unknown }).caso === "string" ? String((parsed.data as { caso: string }).caso) : null
      const casoSeguro = caso && /^[a-z0-9-]+$/.test(caso) && existsSync(join(ctx.services.paths.fixtures, "casos", caso)) ? caso : null
      try {
        await registrarAuditoria(ctx.services, {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          runId: null,
          caso: casoSeguro,
          evento: `proveedor_${def.nombre}`,
          ok: result.ok,
          resumen: result.ok ? def.resumir(result.data) : `error: ${result.error}`,
        })
      } catch (err) {
        console.error("[audit]", err)
      }
      return JSON.stringify(result)
    },
  }
}

const caso = z.string().min(1).max(80).describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/ (ej. ec-corp-andina)")
const rel = (caso: string, ...p: string[]): string => ["out", caso, ...p].join("/")

async function runRequerido(ctx: ToolContext, c: string): Promise<Run> {
  const run = await obtenerRunPropio(ctx.services.db, c, ctx.userId)
  if (!run) throw new DomainError(`El caso "${c}" aún no se ha leído; ejecuta proveedor_leer_solicitud primero.`, "sin_run")
  return run
}

// ---------------------------------------------------------------- leer_solicitud (HU-1)
export const leer_solicitud = definir({
  nombre: "leer_solicitud",
  description: "Lee el correo y la plantilla del caso y devuelve país, cliente, formato de salida, campos solicitados y soportes exigidos.",
  args: { caso },
  async run(a, ctx) {
    const s = ctx.services
    const k = await cargarCaso(s.paths, a.caso)
    const run = await asegurarRun(s, { caso: a.caso, userId: ctx.userId, sessionId: ctx.sessionId, formato: k.solicitud.formato })
    const [glosario, maestro] = await Promise.all([cargarGlosario(s.paths), cargarMaestro(s.paths)])
    const ambiguos = mapearCampos(k.campos, k.solicitud.pais, glosario, maestro)
      .filter((c) => c.estado === "requiere_confirmacion")
      .map((c) => ({ etiqueta: c.etiqueta, motivo: c.motivo ?? "", propuesta: c.propuesta ?? null }))
    const advertencias: string[] = []
    if (k.plantillaError) advertencias.push(`${k.plantillaError} Se puede continuar con la revisión de soportes (proveedor_armar_paquete).`)
    if (k.solicitud.formato === "portal") advertencias.push("Formato portal web: no soportado para llenado automático; se prepararán los valores para copiar.")
    const faltanAdjuntos = k.solicitud.adjuntos.filter((x) => !k.adjuntosDisponibles.includes(x))
    if (faltanAdjuntos.length) advertencias.push(`Adjunto(s) original(es) no incluidos en los fixtures: ${faltanAdjuntos.join(", ")}. La plantilla base se deriva de la especificación de campos.`)
    return ok({
      caso: a.caso,
      pais: k.solicitud.pais,
      cliente: k.solicitud.cliente,
      formato: k.solicitud.formato,
      asunto: k.solicitud.asunto,
      fecha_solicitud: k.solicitud.fecha,
      identificador_tributario_pais: ID_TRIBUTARIO[k.solicitud.pais] ?? null,
      campos: k.campos.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio })),
      soportes: k.soportesExigidos,
      requiere_confirmacion: ambiguos,
      adjuntos: k.solicitud.adjuntos,
      advertencias,
      estado_caso: run.state,
    })
  },
  resumir: (d) => `${d.caso}: ${d.pais}, formato ${d.formato}, ${d.campos.length} campos, ${d.soportes.length} soportes`,
})

// ---------------------------------------------------------------- mapear_campos (HU-2)
export const mapear_campos = definir({
  nombre: "mapear_campos",
  description: "Cruza los campos solicitados con el repositorio maestro y clasifica cada uno como lleno, faltante o requiere_confirmacion.",
  args: {
    caso,
    campos: z.array(z.string().min(1).max(200)).max(200).describe("Etiquetas de campos devueltas por proveedor_leer_solicitud"),
  },
  async run(a, ctx) {
    const s = ctx.services
    const run = await runRequerido(ctx, a.caso)
    const k = await cargarCaso(s.paths, a.caso)
    if (k.plantillaError) return fail(`${k.plantillaError} No hay campos que mapear; puedes continuar con proveedor_armar_paquete para revisar soportes.`)
    const conocidas = new Set(k.campos.map((c) => normalizar(c.etiqueta)))
    const desconocidas = a.campos.filter((c) => !conocidas.has(normalizar(c)))
    if (desconocidas.length) return fail(`Etiquetas que no están en la plantilla del caso (no se inventan campos): ${desconocidas.join(", ")}`)
    const [glosario, maestro] = await Promise.all([cargarGlosario(s.paths), cargarMaestro(s.paths)])
    // Siempre se mapea la plantilla completa: el resultado no depende de lo que proponga el modelo.
    const mapeo = mapearCampos(k.campos, k.solicitud.pais, glosario, maestro)
    const mapeoHash = hashMapeo(mapeo)
    await transicionar(s, { run, userId: ctx.userId, hacia: "mapeado", patch: { mapping: mapeo, mapping_hash: mapeoHash, formulario: null, payload: null, payload_hash: null, listo_para_firma: null } })
    const vista = (c: CampoMapeado) => ({ etiqueta: c.etiqueta, ruta: c.ruta, valor: valorParaLlm(c.ruta, maestro), confianza: c.confianza })
    return ok({
      caso: a.caso,
      mapeo_hash: mapeoHash,
      llenos: mapeo.filter((c) => c.estado === "lleno").map(vista),
      faltantes: mapeo.filter((c) => c.estado === "faltante").map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio, motivo: c.motivo ?? "" })),
      requiere_confirmacion: mapeo.filter((c) => c.estado === "requiere_confirmacion").map((c) => ({ ...vista(c), motivo: c.motivo ?? "", propuesta: c.propuesta ?? null })),
      nota_privacidad: "Los valores [PROTEGIDO:...] se resuelven solo en el servidor al generar el formulario.",
    })
  },
  resumir: (d) => `${d.caso}: ${d.llenos.length} llenos, ${d.faltantes.length} faltantes, ${d.requiere_confirmacion.length} por confirmar`,
})

// ---------------------------------------------------------------- generar_formulario (HU-3)

export const generar_formulario = definir({
  nombre: "generar_formulario",
  description: "Genera el formulario lleno en el formato pedido por el cliente (xlsx o pdf) a partir del mapeo vigente; para portal web prepara los valores para copiar.",
  args: {
    caso,
    mapeo: z.string().regex(/^[a-f0-9]{64}$/).describe("mapeo_hash devuelto por proveedor_mapear_campos; garantiza que se usa el mapeo vigente del servidor"),
  },
  async run(a, ctx) {
    const s = ctx.services
    const run = await runRequerido(ctx, a.caso)
    if (!run.mapping_hash || run.mapping_hash !== a.mapeo) return fail("El mapeo indicado no es el vigente para este caso; ejecuta proveedor_mapear_campos de nuevo.")
    const k = await cargarCaso(s.paths, a.caso)
    const maestro = await cargarMaestro(s.paths)
    const mapeo = run.mapping as CampoMapeado[]
    const valores = mapeo.map((c) => valorParaFormulario(c, maestro))
    const dirFixtureCaso = join(s.paths.fixtures, "casos", a.caso)
    const archivos: Array<{ nombre: string; bytes: Uint8Array | string }> = []
    let principal: string
    let origen = "n/a"
    let escritas = 0
    let vacias = 0
    let soportado = true

    if (k.solicitud.formato === "xlsx" && k.celdas) {
      const adj = k.adjuntosDisponibles.find((x) => x.toLowerCase().endsWith(".xlsx"))
      const base = await cargarPlantillaXlsx(k.celdas, adj ? join(dirFixtureCaso, adj) : null)
      origen = base.origen
      if (base.origen !== "adjunto_original") archivos.push({ nombre: "plantilla-base.xlsx", bytes: await xlsxBuffer(base.wb) })
      const r = await rellenarXlsx(base.wb, k.celdas, valores)
      ;({ escritas, vacias } = r)
      principal = "formulario.xlsx"
      archivos.push({ nombre: principal, bytes: await xlsxBuffer(base.wb) })
    } else if (k.solicitud.formato === "pdf" && k.camposPdf) {
      const adj = k.adjuntosDisponibles.find((x) => x.toLowerCase().endsWith(".pdf"))
      const base = await cargarPlantillaPdf(k.camposPdf, `Formulario de registro de proveedor — ${k.solicitud.cliente}`, adj ? join(dirFixtureCaso, adj) : null)
      origen = base.origen
      if (base.origen !== "adjunto_original") archivos.push({ nombre: "plantilla-base.pdf", bytes: base.bytes })
      const r = await rellenarPdf(base.bytes, k.camposPdf, valores)
      ;({ escritas, vacias } = r)
      principal = "formulario.pdf"
      archivos.push({ nombre: principal, bytes: r.bytes })
    } else if (k.solicitud.formato === "portal") {
      soportado = false
      principal = "valores-portal.md"
      const filas = mapeo.map((c, i) => `| ${i + 1} | ${c.etiqueta.replace(/\|/g, "\\|")} | ${String(valores[i] ?? "").replace(/\|/g, "\\|")} | ${c.estado}${c.motivo ? ` (${c.motivo})` : ""} |`)
      escritas = valores.filter((v) => v !== null).length
      vacias = valores.length - escritas
      archivos.push({
        nombre: principal,
        bytes: [
          `# Valores para el portal — ${k.solicitud.cliente}`,
          "",
          "> Formato no soportado para llenado automático. Copie estos valores en el portal.",
          "> Las credenciales del portal las ingresa una persona; nunca se almacenan aquí. El clic en \"Enviar\" es humano.",
          "",
          "| # | Campo | Valor | Estado |",
          "|---|---|---|---|",
          ...filas,
          "",
        ].join("\n"),
      })
    } else {
      return fail(`${k.plantillaError ?? "Plantilla no disponible."} No se puede generar el formulario; puedes continuar con proveedor_armar_paquete.`)
    }

    const dir = join(s.paths.out, a.caso)
    const formulario = { archivo: principal, formato: k.solicitud.formato, origen_plantilla: origen, sha256: sha256(archivos.find((x) => x.nombre === principal)?.bytes ?? "") }
    await transicionar(s, { run, userId: ctx.userId, hacia: "formulario_generado", patch: { formulario, payload: null, payload_hash: null, listo_para_firma: null } }, async () => {
      for (const f of archivos) await writeAtomic(join(dir, f.nombre), f.bytes)
    })
    return ok({
      ruta: rel(a.caso, principal),
      formato: k.solicitud.formato,
      soportado,
      ...(soportado ? {} : { aviso: "formato no soportado: portal web. Se generó valores-portal.md con los valores listos para copiar." }),
      origen_plantilla: origen,
      campos_escritos: escritas,
      campos_vacios: vacias,
    })
  },
  resumir: (d) => `${d.ruta} (${d.formato}${d.soportado ? "" : ", no soportado"}), ${d.campos_escritos} escritos, ${d.campos_vacios} vacíos`,
})

// ---------------------------------------------------------------- armar_paquete (HU-4)
export const armar_paquete = definir({
  nombre: "armar_paquete",
  description: "Arma out/<caso>/paquete con formulario, soportes, checklist y borrador de correo, y determina si está listo para firma.",
  args: { caso },
  async run(a, ctx) {
    const s = ctx.services
    const run = await runRequerido(ctx, a.caso)
    const k = await cargarCaso(s.paths, a.caso)
    const [indice, maestro] = await Promise.all([cargarIndiceSoportes(s.paths), cargarMaestro(s.paths)])
    const asOf = s.clock.today()
    const ev = evaluarSoportes(k.soportesExigidos, indice, asOf)
    const mapeo = (run.mapping as CampoMapeado[] | null) ?? []
    const formulario = run.formulario as { archivo: string } | null
    const bloqueos = [...ev.bloqueos]
    if (!formulario) bloqueos.push("Formulario no generado")
    const listo = bloqueos.length === 0
    const faltantes = mapeo.filter((c) => c.estado === "faltante")
    const porConfirmar = mapeo.filter((c) => c.estado === "requiere_confirmacion")

    // Se arma en un directorio temporal y se publica con rename dentro de la transacción.
    const dirCaso = join(s.paths.out, a.caso)
    const staging = join(dirCaso, `.paquete-${randomUUID()}`)
    await resetDir(staging)
    try {
      if (formulario) await copyAtomic(join(dirCaso, formulario.archivo), join(staging, formulario.archivo))
      for (const it of ev.items) if (it.archivo) await copyAtomic(rutaSoporte(s.paths, it.archivo), join(staging, "soportes", it.archivo))
      const checklist = [
        `# Checklist — ${k.solicitud.cliente} (${a.caso})`,
        "",
        `- Fecha de referencia de vigencias: ${asOf}`,
        `- Estado: **${listo ? "LISTO PARA FIRMA" : "BLOQUEADO"}**`,
        ...bloqueos.map((b) => `  - ${b}`),
        "",
        "## Soportes exigidos",
        "| Soporte | Estado | Archivo | Vigencia hasta |",
        "|---|---|---|---|",
        ...ev.items.map((i) => `| ${i.tipo} | ${i.estado} | ${i.archivo ?? "—"} | ${i.vigencia_hasta ?? "no aplica"} |`),
        "",
        "## Campos faltantes (no bloquean la firma; RN3)",
        ...(faltantes.length ? faltantes.map((c) => `- ${c.etiqueta}${c.obligatorio ? " (obligatorio)" : ""}: ${c.motivo ?? ""}`) : ["- Ninguno"]),
        "",
        "## Campos que requieren confirmación humana",
        ...(porConfirmar.length ? porConfirmar.map((c) => `- ${c.etiqueta}: ${c.motivo ?? ""}${c.propuesta ? ` — ${c.propuesta}` : ""}`) : ["- Ninguno"]),
        "",
        "## Firma",
        "- [ ] Revisión de la analista",
        "- [ ] Firma del representante legal (fuera del sistema)",
        "",
      ].join("\n")
      const presentes = ev.items.filter((i) => i.archivo)
      const correo = [
        `Para: ${k.solicitud.de}`,
        `Asunto: RE: ${k.solicitud.asunto}`,
        "",
        "Estimados,",
        "",
        `Adjuntamos el formulario de registro de proveedor de ${String(maestro.razon_social ?? "")} diligenciado${formulario ? ` (${formulario.archivo})` : ""}, junto con los siguientes soportes:`,
        ...presentes.map((i) => `- ${i.descripcion ?? i.tipo}`),
        ...(ev.items.some((i) => i.estado !== "presente") ? ["", "Quedan pendientes de actualización o envío posterior:", ...ev.items.filter((i) => i.estado !== "presente").map((i) => `- ${i.descripcion ?? i.tipo} (${i.estado})`)] : []),
        "",
        "Quedamos atentos a cualquier inquietud.",
        "",
        "Cordialmente,",
        "Área Administrativa",
        "",
        "> BORRADOR generado automáticamente. Requiere revisión y firma humana antes de enviarse.",
        "",
      ].join("\n")
      // RN2: datos bancarios nunca en el borrador de correo.
      if (contieneSensible(correo, valoresSensibles(maestro))) throw new DomainError("El borrador de correo contendría datos sensibles; se abortó.", "privacidad")
      await writeAtomic(join(staging, "checklist.md"), checklist)
      await writeAtomic(join(staging, "borrador-correo.md"), correo)
      const archivos = await hashDirectorio(staging)
      const payload: PayloadPaquete = { caso: a.caso, as_of: asOf, listo_para_firma: listo, bloqueos, archivos }
      const payloadHash = hashPayload(payload)
      await transicionar(s, { run, userId: ctx.userId, hacia: "paquete_armado", patch: { payload, payload_hash: payloadHash, listo_para_firma: listo, as_of: asOf } }, async (q, nuevo) => {
        await rm(join(dirCaso, "paquete"), { recursive: true, force: true })
        await rename(staging, join(dirCaso, "paquete"))
        for (const b of bloqueos) await registrarAlerta(s, ctx.userId, nuevo.id, { severidad: "advertencia", codigo: "paquete_bloqueado", mensaje: `${a.caso}: ${b}` }, q)
      })
      return ok({
        ruta: rel(a.caso, "paquete"),
        listo_para_firma: listo,
        bloqueos,
        checklist: {
          fecha_referencia: asOf,
          soportes: ev.items.map((i) => ({ tipo: i.tipo, estado: i.estado, vigencia_hasta: i.vigencia_hasta })),
          campos_faltantes: faltantes.map((c) => c.etiqueta),
          campos_por_confirmar: porConfirmar.map((c) => c.etiqueta),
        },
        archivos: Object.keys(archivos).map((f) => rel(a.caso, "paquete", f)),
        payload_hash: payloadHash.slice(0, 12),
      })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  },
  resumir: (d) => `${d.ruta}: ${d.listo_para_firma ? "listo para firma" : `bloqueado (${d.bloqueos.length})`}`,
})

// ---------------------------------------------------------------- simular_envio (HU-4 / RN4)
export const simular_envio = definir({
  nombre: "simular_envio",
  description: "Solicita el envío simulado del paquete; solo se ejecuta tras confirmación humana explícita en la interfaz, nunca por el modelo.",
  args: {
    caso,
    confirmado: z.boolean().describe("true solo si el usuario pidió enviar en su último mensaje; aun así el servidor exige la confirmación humana ligada al paquete"),
  },
  async run(a, ctx): Promise<Result<{ ruta: string; ya_enviado: boolean }>> {
    const s = ctx.services
    const run = await runRequerido(ctx, a.caso)
    if (run.state === "enviado") {
      const e = await s.db.query<{ ruta: string }>("SELECT ruta FROM envios WHERE run_id = $1 AND payload_hash = $2", [run.id, run.payload_hash])
      if (e.rows[0]) return ok({ ruta: e.rows[0].ruta, ya_enviado: true })
    }
    if (run.state !== "paquete_armado" && run.state !== "confirmacion_pendiente") return fail("El paquete no está armado; ejecuta proveedor_armar_paquete antes de proponer un envío.")
    if (!a.confirmado) return fail("requiere confirmación explícita")
    const pend = await solicitarConfirmacion(s, { run, userId: ctx.userId, sessionId: ctx.sessionId })
    ctx.onConfirmationRequired?.(pend)
    return failCon("requiere confirmación explícita", {
      confirmacion: {
        estado: "pendiente",
        version: pend.version,
        hash_paquete: pend.payloadHash.slice(0, 12),
        expira: pend.expiresAt,
        listo_para_firma: pend.listoParaFirma,
        bloqueos: pend.bloqueos,
        instruccion: "La persona usuaria debe pulsar 'Confirmar envío' en la interfaz. El modelo no puede confirmar.",
      },
    })
  },
  resumir: (d) => `${d.ruta}${d.ya_enviado ? " (ya enviado)" : ""}`,
})

export const herramientas = { leer_solicitud, mapear_campos, generar_formulario, armar_paquete, simular_envio } as const
