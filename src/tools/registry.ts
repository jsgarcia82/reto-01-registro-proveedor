import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import type { ToolSpec } from "../llm/adapter.js"
import type { ToolContext } from "../services/context.js"
import { herramientas, type Herramienta } from "./proveedor.js"

/** Nombre que ve el modelo: <archivo>_<export> (PRD §6.2). */
export const registro: Record<string, Herramienta> = Object.fromEntries(Object.entries(herramientas).map(([k, v]) => [`proveedor_${k}`, v as Herramienta]))

export const toolSpecs: ToolSpec[] = Object.entries(registro).map(([name, t]) => ({
  name,
  description: t.description,
  inputSchema: zodToJsonSchema(z.object(t.args), { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>,
}))

/** Ejecuta por nombre; nombres desconocidos o argumentos inválidos vuelven al modelo como error, sin excepción. */
export async function ejecutarHerramienta(name: string, args: unknown, ctx: ToolContext): Promise<string> {
  const t = registro[name]
  if (!t) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${name}` })
  return t.execute(args, ctx)
}
