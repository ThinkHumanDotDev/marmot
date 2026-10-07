import { z } from 'zod'

import { cidrListError } from '@/lib/cidr-syntax'
import { connectivityTargetsError } from '@/lib/connectivity-targets'

/**
 * Central, validated view of process.env. Import `env` everywhere instead of reading
 * process.env directly so misconfiguration fails fast with a readable message.
 *
 * Keep every variable documented in `.env.example` and `docs/Configuration.md`.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  )

/** Comma-separated CIDR list (`10.0.0.0/8, fd00::/8`); a malformed entry fails at startup. */
const cidrList = z
  .string()
  .default('')
  .superRefine((value, ctx) => {
    const message = cidrListError(value)
    if (message) ctx.addIssue({ code: 'custom', message })
  })

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MARMOT_ROLE: z.enum(['web', 'worker', 'realtime', 'all']).default('all'),

  PAYLOAD_SECRET: z.string().min(16, 'PAYLOAD_SECRET must be at least 16 characters'),
  NEXT_PUBLIC_SERVER_URL: z.string().url().default('http://localhost:3000'),
  // Extra origins (comma-separated) allowed by Payload's CORS/CSRF checks besides the server URL.
  ADDITIONAL_ORIGINS: z.string().default(''),

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
  // Who may point an `smtp` notification channel at the SMTP_* settings above ("Use the server
  // SMTP settings"): everyone who manages channels, instance superadmins only, or nobody.
  NOTIFICATIONS_SERVER_SMTP: z.enum(['all', 'superadmin', 'off']).default('superadmin'),
  // Messages per organization per hour sent through the server SMTP settings; 0 = unlimited.
  NOTIFICATIONS_SERVER_SMTP_RATE: z.coerce.number().int().min(0).default(60),

  // Auth
  DISABLE_SIGNUP: booleanish.default(false),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_DISPLAY_NAME: z.string().default('Single sign-on'),
  OIDC_AUTO_PROVISION: booleanish.default(true),
  OIDC_SCOPES: z.string().default('openid email profile'),
  // Social sign-in presets; each pair enables its button.
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Monitoring defaults
  KEEP_DATA_PERIOD_DAYS: z.coerce.number().int().default(365),
  // Audit log rows are pruned after this many days by the retention job; 0 keeps them forever.
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  // Outbound webhooks (#157): days the delivery log keeps a delivery, and how many deliveries in a
  // row must fail (after their retries) before an endpoint is disabled (0 never disables).
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  WEBHOOK_DISABLE_AFTER_FAILURES: z.coerce.number().int().min(0).default(5),
  // Polling engine (worker): parallel checks per worker process.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  // On-demand checks ("Check now" and ad-hoc tests) allowed per organization and minute.
  ON_DEMAND_CHECKS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  // Self connectivity check (worker): while the worker itself cannot reach the internet, checks of
  // external targets are held as PENDING "checker offline" beats instead of going DOWN. Off by default.
  CONNECTIVITY_CHECK_ENABLED: booleanish.default(false),
  // Comma-separated probe targets: `host:port` (TCP connect) or `http(s)://…` (any HTTP response).
  CONNECTIVITY_CHECK_TARGETS: z
    .string()
    .default('1.1.1.1:53, 8.8.8.8:53, https://www.google.com/generate_204')
    .superRefine((value, ctx) => {
      const message = connectivityTargetsError(value)
      if (message) ctx.addIssue({ code: 'custom', message })
    }),
  // `any`: online when at least one target answers; `all`: every target must answer.
  CONNECTIVITY_CHECK_MODE: z.enum(['any', 'all']).default('any'),
  // Seconds between probes (the verdict is cached for this long) and per-target timeout in seconds.
  CONNECTIVITY_CHECK_INTERVAL: z.coerce.number().int().min(5).max(3600).default(30),
  CONNECTIVITY_CHECK_TIMEOUT: z.coerce.number().int().min(1).max(60).default(5),
  // "Checker offline" / "back online" notices: email every instance superadmin, and/or deliver
  // through one notification channel (its id).
  CONNECTIVITY_CHECK_NOTIFY_EMAIL: booleanish.default(true),
  CONNECTIVITY_CHECK_NOTIFICATION_ID: z.string().optional(),
  // Docker monitors: allow Docker hosts that connect through a local unix socket (the worker's own
  // daemon). Turn off on shared instances where organizations must not reach the host's Docker.
  DOCKER_SOCKET_ENABLED: booleanish.default(true),
  // Outbound address guard for monitors and notifications (see docs/Security.md). Off by default so
  // single-team installs can monitor their own network; turn it on when untrusted users can sign up.
  MONITOR_DENY_PRIVATE_ADDRESSES: booleanish.default(false),
  // Extra ranges that are always denied, and exceptions to the private ranges (comma-separated CIDRs).
  MONITOR_DENY_CIDRS: cidrList,
  MONITOR_ALLOW_CIDRS: cidrList,
  // Skip the Redis side effects of the `monitors` hooks (tests without Redis).
  MARMOT_DISABLE_ENGINE_HOOKS: booleanish.default(false),

  // Lifetime of the cookie a visitor gets after signing in to a protected status page.
  STATUS_PAGE_SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // Marketing landing page at `/` for signed-out visitors (hosted instance). Off on self-host:
  // `/` then routes straight to the setup wizard or the login page.
  LANDING_PAGE_ENABLED: booleanish.default(false),

  // Billing scaffold (disabled by default on self-host)
  BILLING_ENABLED: booleanish.default(false),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

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

/**
 * Forgets the parsed env so the next access re-reads `process.env`. Intended for tests that flip
 * variables such as `DISABLE_SIGNUP` at runtime; production code never needs it.
 */
export function resetEnvCache(): void {
  cached = undefined
}

export const isProduction = () => env.NODE_ENV === 'production'
export const runsRole = (role: Exclude<Env['MARMOT_ROLE'], 'all'>) =>
  env.MARMOT_ROLE === 'all' || env.MARMOT_ROLE === role
