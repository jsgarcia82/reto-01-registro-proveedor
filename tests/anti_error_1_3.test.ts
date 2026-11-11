import { randomUUID } from "node:crypto"
import { dbPrueba } from "./helpers.js"
import type { Db } from "../src/db/db.js"

/** anti_error_1_3: el modelo SQL tiene FK a usuarios en todas las tablas de negocio. */
describe("anti_error_1_3 — SQL con FK a usuarios", () => {
  let db: Db
  let limpiar: () => Promise<void>
  beforeEach(async () => ({ db, limpiar } = await dbPrueba()))
  afterEach(() => limpiar())

  it("cada tabla (salvo users) tiene user_id NOT NULL con FK a users(id)", async () => {
    const tablas = ["auth_sessions", "chat_sessions", "messages", "runs", "confirmations", "envios", "audit_log", "alerts"]
    const fks = await db.query<{ table_name: string; column_name: string }>(
      `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'users' AND ccu.column_name = 'id' AND tc.table_schema = current_schema()`,
    )
    for (const t of tablas) expect(fks.rows, `FK a users en ${t}`).toContainEqual({ table_name: t, column_name: "user_id" })
    const nulos = await db.query<{ table_name: string; is_nullable: string }>(
      "SELECT table_name, is_nullable FROM information_schema.columns WHERE column_name = 'user_id' AND table_schema = current_schema()",
    )
    for (const r of nulos.rows) expect(r.is_nullable, `user_id NOT NULL en ${r.table_name}`).toBe("NO")
  })

  it("la base rechaza un run o una sesión con usuario inexistente", async () => {
    await expect(db.query("INSERT INTO chat_sessions (id, user_id) VALUES ($1,$2)", [randomUUID(), randomUUID()])).rejects.toThrow(/foreign key|violates/i)
    await expect(db.query("INSERT INTO runs (id, caso, user_id, state, formato) VALUES ($1,'x',$2,'leido','xlsx')", [randomUUID(), randomUUID()])).rejects.toThrow(/foreign key|violates/i)
  })

  it("restricciones únicas que soportan propiedad del caso e idempotencia", async () => {
    const u = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexdef ILIKE '%UNIQUE%'")
    const defs = u.rows.map((r) => r.indexdef).join("\n")
    expect(defs).toMatch(/runs.*\(caso\)/)
    expect(defs).toMatch(/envios.*\(idempotency_key\)/)
    expect(defs).toMatch(/confirmations.*\(token_hash\)/)
    expect(defs).toMatch(/messages.*\(session_id, seq\)/)
  })
})
