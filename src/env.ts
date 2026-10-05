import { z } from 'zod'

/**
 * Central, validated view of process.env. Import `env` everywhere instead of reading
 * process.env directly so misconfiguration fails fast with a readable message.
 *
 * Keep every variable documented in `.env.example` and `docs/configuration.md`.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  )

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MARMOT_ROLE: z.enum(['web', 'worker', 'realtime', 'all']).default('all'),

  PAYLOAD_SECRET: z.string().min(16, 'PAYLOAD_SECRET must be at least 16 characters'),
  NEXT_PUBLIC_SERVER_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_ADAPTER: z.enum(['postgres', 'mongodb', 'sqlite']).default('postgres'),
  DATABASE_URL: z.string().min(1),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  REALTIME_PORT: z.coerce.number().int().positive().default(3001),
  NEXT_PUBLIC_REALTIME_URL: z.string().optional(),

  // Storage: local disk by default; S3 when S3_BUCKET is set.
  UPLOADS_DIR: z.string().default('uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish.default(false),

  // Email (generic SMTP). When SMTP_HOST is unset, mail is logged to the console.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: booleanish.default(false),
  EMAIL_FROM: z.string().default('Marmot <marmot@localhost>'),

  // Auth
  DISABLE_SIGNUP: booleanish.default(false),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_DISPLAY_NAME: z.string().default('Single sign-on'),
  OIDC_AUTO_PROVISION: booleanish.default(true),

  // Monitoring defaults
  KEEP_DATA_PERIOD_DAYS: z.coerce.number().int().default(365),
  // Polling engine (worker): parallel checks per worker process.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  // Skip the Redis side effects of the `monitors` hooks (tests without Redis).
  MARMOT_DISABLE_ENGINE_HOOKS: booleanish.default(false),

  // Billing scaffold (disabled by default on self-host)
  BILLING_ENABLED: booleanish.default(false),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Telemetry (opt-in)
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().default('https://us.i.posthog.com'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return parsed.data
}

/** Lazily parsed env. Access as `env.X` — parsing happens on first access. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: keyof Env) {
    cached ??= loadEnv()
    return cached[prop]
  },
})

export const isProduction = () => env.NODE_ENV === 'production'
export const runsRole = (role: Exclude<Env['MARMOT_ROLE'], 'all'>) =>
  env.MARMOT_ROLE === 'all' || env.MARMOT_ROLE === role
