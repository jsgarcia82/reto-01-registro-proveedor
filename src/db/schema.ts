/**
 * Esquema relacional. Toda tabla de negocio tiene FK a users (anti_error_1_3).
 * Las restricciones UNIQUE soportan la idempotencia distribuida y el registro de procesados.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokens_used integer NOT NULL DEFAULT 0,
  busy_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'event')),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  caso text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('leido', 'mapeado', 'formulario_generado', 'paquete_armado', 'confirmacion_pendiente', 'enviado')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  formato text NOT NULL,
  mapping jsonb,
  mapping_hash text,
  formulario jsonb,
  payload jsonb,
  payload_hash text,
  listo_para_firma boolean,
  as_of text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS confirmations (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  run_version integer NOT NULL,
  payload_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Registro de procesados: un envío por (run, payload). La clave de idempotencia es UNIQUE.
CREATE TABLE IF NOT EXISTS envios (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL UNIQUE REFERENCES confirmations(id),
  idempotency_key text NOT NULL UNIQUE,
  payload_hash text NOT NULL,
  listo_para_firma boolean NOT NULL,
  ruta text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  evento text NOT NULL,
  ok boolean NOT NULL,
  resumen text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  severidad text NOT NULL CHECK (severidad IN ('info', 'advertencia', 'critica')),
  codigo text NOT NULL,
  mensaje text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now()
);
`
