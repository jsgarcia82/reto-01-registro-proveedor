/**
 * Genera modulo/agent.md y modulo/skill/registro-proveedor/SKILL.md a partir de las MISMAS fuentes que usa la app
 * (agent/prompt.md y src/knowledge/registro-proveedor.md). tests/modulo.test.ts falla si divergen.
 *   npx tsx scripts/build-modulo.ts
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const AGENT_FRONTMATTER = `---
description: Prepara formularios de registro como proveedor (xlsx/pdf/portal) y el paquete para firma; nunca envía sin confirmación humana.
mode: primary
permission:
  edit: deny
  bash: deny
---
`
export const SKILL_FRONTMATTER = `---
name: registro-proveedor
description: Reglas del proceso de registro como proveedor de Periferia (estados de campo, identificador tributario por país, vigencias de soportes, datos bancarios, formatos y envío con confirmación).
---
`
export function construir(): { agent: string; skill: string } {
  return {
    agent: AGENT_FRONTMATTER + readFileSync(join(ROOT, "agent", "prompt.md"), "utf8"),
    skill: SKILL_FRONTMATTER + readFileSync(join(ROOT, "src", "knowledge", "registro-proveedor.md"), "utf8"),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { agent, skill } = construir()
  writeFileSync(join(ROOT, "modulo", "agent.md"), agent)
  writeFileSync(join(ROOT, "modulo", "skill", "registro-proveedor", "SKILL.md"), skill)
  console.log("modulo/ actualizado desde agent/prompt.md y src/knowledge/registro-proveedor.md")
}
