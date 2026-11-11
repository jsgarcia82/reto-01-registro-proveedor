import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto"
import type { Db } from "../db/db.js"
import { sha256 } from "../domain/core.js"

export interface Usuario {
  id: string
  email: string
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 32).toString("base64")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split("$")
  if (alg !== "scrypt" || !salt || !hash) return false
  const expected = Buffer.from(hash, "base64")
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length)
  return timingSafeEqual(expected, actual)
}

export async function upsertUsuario(db: Db, email: string, password: string): Promise<Usuario> {
  const r = await db.query<Usuario>(
    "INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id, email",
    [randomUUID(), email.toLowerCase(), hashPassword(password)],
  )
  const u = r.rows[0]
  if (!u) throw new Error("no se pudo crear el usuario")
  return u
}

export async function autenticar(db: Db, email: string, password: string): Promise<Usuario | null> {
  const r = await db.query<{ id: string; email: string; password_hash: string }>("SELECT id, email, password_hash FROM users WHERE email = $1", [email.toLowerCase()])
  const u = r.rows[0]
  // se verifica siempre un hash para no filtrar por tiempo si el correo existe
  const ok = verifyPassword(password, u?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
  return u && ok ? { id: u.id, email: u.email } : null
}

export async function crearSesionAuth(db: Db, userId: string, now: Date, ttlHoras = 8): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await db.query("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)", [
    randomUUID(),
    userId,
    sha256(token),
    new Date(now.getTime() + ttlHoras * 3600_000).toISOString(),
  ])
  return token
}

export async function usuarioPorToken(db: Db, token: string, now: Date): Promise<Usuario | null> {
  const r = await db.query<Usuario>(
    "SELECT u.id, u.email FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2",
    [sha256(token), now.toISOString()],
  )
  return r.rows[0] ?? null
}

export async function cerrarSesionAuth(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM auth_sessions WHERE token_hash = $1", [sha256(token)])
}

/** DEMO_USERS="correo:clave,correo2:clave2". Sin valor: genera una clave aleatoria para analista@local. */
export function parseDemoUsers(raw: string | undefined): { usuarios: Array<{ email: string; password: string }>; generada: boolean } {
  if (!raw) return { usuarios: [{ email: "analista@local", password: randomBytes(9).toString("base64url") }], generada: true }
  const usuarios = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":")
      if (i <= 0 || i === p.length - 1) throw new Error("DEMO_USERS debe tener el formato correo:clave[,correo:clave]")
      return { email: p.slice(0, i), password: p.slice(i + 1) }
    })
  return { usuarios, generada: false }
}

export async function crearSesionChat(db: Db, userId: string): Promise<string> {
  const id = randomUUID()
  await db.query("INSERT INTO chat_sessions (id, user_id) VALUES ($1,$2)", [id, userId])
  return id
}
