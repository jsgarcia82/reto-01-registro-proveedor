import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as modulo from "../modulo/tools/proveedor.js"
import { construir } from "../scripts/build-modulo.js"
import { herramientas } from "../src/tools/proveedor.js"
import { ROOT } from "./helpers.js"

/** Bonus §9.4: las tres piezas del módulo son las mismas que usa la app (sin copias divergentes). */
describe("modulo/ reutilizable", () => {
  it("agent.md y SKILL.md coinciden byte a byte con agent/prompt.md y src/knowledge (regenerar: npx tsx scripts/build-modulo.ts)", () => {
    const { agent, skill } = construir()
    expect(readFileSync(join(ROOT, "modulo", "agent.md"), "utf8")).toBe(agent)
    expect(readFileSync(join(ROOT, "modulo", "skill", "registro-proveedor", "SKILL.md"), "utf8")).toBe(skill)
    expect(agent).toMatch(/mode: primary/)
    expect(agent).toMatch(/edit: deny/)
    expect(agent).toMatch(/bash: deny/)
  })

  it("las herramientas del módulo son los mismos objetos que usa el servidor", () => {
    for (const [k, v] of Object.entries(herramientas)) expect((modulo as Record<string, unknown>)[k]).toBe(v)
  })

  it("se usan sin servidor: contexto local + flujo completo + confirmación humana", async () => {
    const { mkdtemp, cp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const dir = await mkdtemp(join(tmpdir(), "modulo-"))
    await cp(join(ROOT, "fixtures"), join(dir, "fixtures"), { recursive: true })
    try {
      const ctx = await modulo.crearContextoLocal({ directory: dir, asOfDate: "2026-08-25" })
      const r = JSON.parse(await modulo.leer_solicitud.execute({ caso: "co-industrias-delta" }, ctx)) as { ok: boolean }
      expect(r.ok).toBe(true)
      await ctx.services.db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
