import { z } from "zod"

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato YYYY-MM-DD")

const EnvSchema = z.object({
  LLM_PROVIDER: z.enum(["anthropic", "mock"]).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MAX_ITERATIONS_PER_TURN: z.coerce.number().int().min(1).max(100).default(25),
  MAX_TOKENS_PER_SESSION: z.coerce.number().int().positive().default(200_000),
  DATABASE_URL: z.string().min(1).optional(),
  DEMO_USERS: z.string().min(1).optional(),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  AS_OF_DATE: isoDate.optional(),
  BUSINESS_TIMEZONE: z
    .string()
    .default("America/Bogota")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: tz })
        return true
      } catch {
        return false
      }
    }, "zona horaria IANA inválida"),
  CONFIRMATION_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  PORT: z.coerce.number().int().positive().default(3000),
})

export type AppConfig = {
  llmProvider: "anthropic" | "mock"
  anthropicApiKey: string | undefined
  anthropicModel: string
  llmTimeoutMs: number
  maxIterationsPerTurn: number
  maxTokensPerSession: number
  databaseUrl: string | undefined
  demoUsers: string | undefined
  cookieSecure: boolean
  asOfDate: string | undefined
  businessTimezone: string
  confirmationTtlSeconds: number
  port: number
}

/** Lee la configuración del entorno. Las cadenas vacías se tratan como ausentes. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== "") clean[k] = v.trim()
  const e = EnvSchema.parse(clean)
  return {
    llmProvider: e.LLM_PROVIDER ?? (e.ANTHROPIC_API_KEY ? "anthropic" : "mock"),
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    maxIterationsPerTurn: e.MAX_ITERATIONS_PER_TURN,
    maxTokensPerSession: e.MAX_TOKENS_PER_SESSION,
    databaseUrl: e.DATABASE_URL,
    demoUsers: e.DEMO_USERS,
    cookieSecure: e.COOKIE_SECURE === "true",
    asOfDate: e.AS_OF_DATE,
    businessTimezone: e.BUSINESS_TIMEZONE,
    confirmationTtlSeconds: e.CONFIRMATION_TTL_SECONDS,
    port: e.PORT,
  }
}
