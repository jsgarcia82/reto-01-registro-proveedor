import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { DomainError, sha256 } from "./core.js"

/** Fixtures: solo lectura. Este módulo nunca escribe en fixtures/. */

export const CASO_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string().length(2),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CeldaSchema = z.object({
  hoja: z.string().min(1),
  celda_etiqueta: z.string().regex(/^[A-Z]{1,3}[0-9]{1,5}$/),
  etiqueta: z.string().min(1),
  celda_valor: z.string().regex(/^[A-Z]{1,3}[0-9]{1,5}$/),
})
export type Celda = z.infer<typeof CeldaSchema>

export const CampoPdfSchema = z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() })
export type CampoPdf = z.infer<typeof CampoPdfSchema>

export const SoporteSchema = z.object({
  tipo: z.string(),
  archivo: z.string().regex(/^[A-Za-z0-9._-]+$/),
  vigencia_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  pais_emisor: z.string(),
  descripcion: z.string().optional(),
})
export type Soporte = z.infer<typeof SoporteSchema>

export type Maestro = Record<string, unknown>
export type Glosario = Record<string, string>

export interface CampoSolicitado {
  etiqueta: string
  obligatorio: boolean | null
  hoja?: string
  celda_valor?: string
}

export interface CasoCargado {
  caso: string
  solicitud: Solicitud
  campos: CampoSolicitado[]
  celdas: Celda[] | null
  camposPdf: CampoPdf[] | null
  soportesExigidos: string[]
  /** Error de plantilla (corrupta/ausente): el flujo continúa con soportes. */
  plantillaError: string | null
  /** Adjuntos originales del cliente presentes en el caso. */
  adjuntosDisponibles: string[]
}

export interface Paths {
  fixtures: string // .../fixtures/reto-01
  out: string // .../out
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown
}

export async function listarCasos(paths: Paths): Promise<string[]> {
  const dir = join(paths.fixtures, "casos")
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && CASO_REGEX.test(e.name)).map((e) => e.name).sort()
}

/** Valida el nombre del caso contra la lista real (evita path traversal). */
export async function resolverCaso(paths: Paths, caso: string): Promise<string> {
  const casos = await listarCasos(paths)
  if (!CASO_REGEX.test(caso) || !casos.includes(caso)) {
    throw new DomainError(`El caso "${caso}" no existe. Casos disponibles: ${casos.join(", ")}.`, "caso_inexistente")
  }
  return join(paths.fixtures, "casos", caso)
}

export async function cargarCaso(paths: Paths, caso: string): Promise<CasoCargado> {
  const dir = await resolverCaso(paths, caso)
  const solicitudParse = SolicitudSchema.safeParse(await readJson(join(dir, "solicitud.json")).catch(() => null))
  if (!solicitudParse.success) throw new DomainError(`La solicitud del caso "${caso}" es ilegible o incompleta.`, "solicitud_invalida")
  const solicitud = solicitudParse.data

  const soportesParse = z.array(z.string()).safeParse(await readJson(join(dir, "soportes-exigidos.json")).catch(() => null))
  const soportesExigidos = soportesParse.success ? soportesParse.data : []

  let celdas: Celda[] | null = null
  let camposPdf: CampoPdf[] | null = null
  let plantillaError: string | null = null
  let campos: CampoSolicitado[] = []

  const archivoPlantilla = solicitud.formato === "xlsx" ? "plantilla-celdas.json" : "plantilla-campos.json"
  const ruta = join(dir, archivoPlantilla)
  if (!existsSync(ruta)) {
    plantillaError = `No se encontró ${archivoPlantilla} para el formato ${solicitud.formato}.`
  } else {
    const raw = await readJson(ruta).catch(() => undefined)
    if (solicitud.formato === "xlsx") {
      const p = z.array(CeldaSchema).min(1).safeParse(raw)
      if (p.success) {
        celdas = p.data
        campos = p.data.map((c) => ({ etiqueta: c.etiqueta, obligatorio: null, hoja: c.hoja, celda_valor: c.celda_valor }))
      } else plantillaError = `La plantilla ${archivoPlantilla} está corrupta o no cumple el formato esperado.`
    } else {
      const p = z.array(CampoPdfSchema).min(1).safeParse(raw)
      if (p.success) {
        camposPdf = p.data
        campos = p.data.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
      } else plantillaError = `La plantilla ${archivoPlantilla} está corrupta o no cumple el formato esperado.`
    }
  }

  const adjuntosDisponibles = solicitud.adjuntos.filter((a) => /^[A-Za-z0-9._ -]+$/.test(a) && existsSync(join(dir, a)))
  return { caso, solicitud, campos, celdas, camposPdf, soportesExigidos, plantillaError, adjuntosDisponibles }
}

export async function cargarMaestro(paths: Paths): Promise<Maestro> {
  const raw = await readJson(join(paths.fixtures, "repositorio", "maestro.json"))
  return z.record(z.unknown()).parse(raw)
}

export async function cargarGlosario(paths: Paths): Promise<Glosario> {
  return z.record(z.string()).parse(await readJson(join(paths.fixtures, "glosario-campos.json")))
}

export async function cargarIndiceSoportes(paths: Paths): Promise<Soporte[]> {
  return z.array(SoporteSchema).parse(await readJson(join(paths.fixtures, "repositorio", "soportes", "index.json")))
}

export const rutaSoporte = (paths: Paths, archivo: string): string => join(paths.fixtures, "repositorio", "soportes", archivo)

/** Verifica fixtures/CHECKSUMS.sha256. Devuelve la lista de discrepancias (vacía = íntegros). */
export async function verificarChecksums(fixturesRoot: string): Promise<string[]> {
  const manifest = await readFile(join(fixturesRoot, "CHECKSUMS.sha256"), "utf8")
  const problemas: string[] = []
  for (const line of manifest.split("\n").filter(Boolean)) {
    const [hash, rel] = line.split(/\s+/)
    if (!hash || !rel) continue
    const full = join(fixturesRoot, rel)
    if (!existsSync(full)) {
      problemas.push(`falta ${rel}`)
      continue
    }
    if (sha256(await readFile(full)) !== hash) problemas.push(`modificado ${rel}`)
  }
  return problemas
}
