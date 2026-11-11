import { PGlite } from "@electric-sql/pglite"
import pg from "pg"
import { SCHEMA_SQL } from "./schema.js"

export interface QueryResult<T> {
  rows: T[]
  rowCount: number
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
}

export interface Db extends Queryable {
  readonly kind: "pglite" | "postgres"
  /** Ejecuta fn dentro de una transacción; cualquier excepción provoca ROLLBACK. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** Mutex FIFO mínimo: PGlite tiene una sola conexión; evita que consultas sueltas se intercalen en una transacción ajena. */
class Mutex {
  private tail: Promise<void> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined
    const next = new Promise<void>((r) => (release = r))
    const prev = this.tail
    this.tail = prev.then(() => next)
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

async function createPglite(dataDir?: string): Promise<Db> {
  const lite = dataDir ? await PGlite.create(dataDir) : await PGlite.create()
  const mutex = new Mutex()
  const wrap = (r: { rows: unknown[]; affectedRows?: number }) => ({
    rows: r.rows,
    rowCount: r.affectedRows ?? r.rows.length,
  })
  return {
    kind: "pglite",
    query: <T>(sql: string, params: unknown[] = []) =>
      mutex.run(async () => wrap(await lite.query(sql, params)) as QueryResult<T>),
    tx: <T>(fn: (q: Queryable) => Promise<T>) =>
      mutex.run(() =>
        lite.transaction(async (t) =>
          fn({ query: async <R>(sql: string, params: unknown[] = []) => wrap(await t.query(sql, params)) as QueryResult<R> }),
        ),
      ),
    close: () => lite.close(),
  }
}

function createPostgres(url: string, schema?: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  })
  const wrap = <T>(r: pg.QueryResult) => ({ rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length })
  return {
    kind: "postgres",
    query: async <T>(sql: string, params: unknown[] = []) => wrap<T>(await pool.query(sql, params)),
    tx: async <T>(fn: (q: Queryable) => Promise<T>) => {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const out = await fn({ query: async <R>(sql: string, params: unknown[] = []) => wrap<R>(await client.query(sql, params)) })
        await client.query("COMMIT")
        return out
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}

export interface DbOptions {
  url?: string | undefined
  /** Solo Postgres: esquema aislado (pruebas en CI). */
  schema?: string | undefined
  /** Solo PGlite: directorio de datos; omitido = en memoria. */
  dataDir?: string | undefined
}

export async function createDb(opts: DbOptions = {}): Promise<Db> {
  if (opts.url) {
    if (opts.schema) {
      if (!/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error("nombre de esquema inválido")
      const admin = new pg.Client({ connectionString: opts.url })
      await admin.connect()
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${opts.schema}`)
      await admin.end()
    }
    const db = createPostgres(opts.url, opts.schema)
    await migrar(db)
    return db
  }
  const db = await createPglite(opts.dataDir)
  await migrar(db)
  return db
}

/** Migración idempotente, sentencia a sentencia, en una transacción. */
async function migrar(db: Db): Promise<void> {
  await db.tx(async (q) => {
    for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) await q.query(stmt)
  })
}
