import { mkdir, rename, writeFile, appendFile, rm, copyFile, readdir } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { DomainError, sha256File } from "../domain/core.js"

/** Escritura atómica: archivo temporal + rename (un lector nunca ve un archivo a medias). */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${line}\n`)
}

export async function copyAtomic(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true })
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`
  await copyFile(src, tmp)
  await rename(tmp, dst)
}

export const resetDir = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

/** Ruta dentro de base; rechaza traversal. */
export function safeJoin(base: string, ...parts: string[]): string {
  const target = resolve(base, ...parts)
  const root = resolve(base)
  if (target !== root && !target.startsWith(root + sep)) throw new DomainError("Ruta fuera del directorio permitido.", "ruta_invalida")
  return target
}

/** Hash de cada archivo de un directorio (orden estable) para el payload ligado a la confirmación. */
export async function hashDirectorio(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else out[relative(dir, full).split(sep).join("/")] = await sha256File(full)
    }
  }
  await walk(dir)
  return out
}
