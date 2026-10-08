import { z } from 'zod'

import { cidrListError } from '@/lib/cidr-syntax'
import { connectivityTargetsError } from '@/lib/connectivity-targets'
import { roleMappingSchema } from '@/lib/sso-groups'

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
  // `probe` runs a remote probe agent (#91) instead of a Marmot server: see MARMOT_URL below.
  MARMOT_ROLE: z.enum(['web', 'worker', 'realtime', 'all', 'probe']).default('all'),

  // Required by every role but `probe` (checked by `requireServerVariables` below).
  PAYLOAD_SECRET: z.string().default(''),
  NEXT_PUBLIC_SERVER_URL: z.string().url().default('http://localhost:3000'),
  // Extra origins (comma-separated) allowed by Payload's CORS/CSRF checks besides the server URL.
  ADDITIONAL_ORIGINS: z.string().default(''),

  DATABASE_ADAPTER: z.enum(['postgres', 'mongodb', 'sqlite']).default('postgres'),
  DATABASE_URL: z.string().default(''),

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
  // Groups (docs/Single-Sign-On.md → Groups): claim to read, allow-list, group → role mapping.
  OIDC_GROUP_CLAIM: z.string().trim().min(1).default('groups'),
  OIDC_ALLOWED_GROUPS: z.string().default(''),
  OIDC_ROLE_MAPPING: roleMappingSchema,
  OIDC_ROLE_MAPPING_REMOVE: booleanish.default(false),
  // SSO-only mode: no password logins, sign-ups or resets (break-glass superadmins aside).
  OIDC_DISABLE_LOCAL_LOGIN: booleanish.default(false),
  OIDC_BREAK_GLASS: booleanish.default(false),
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
  // OpenTelemetry metrics export (#99): instance switch, how long data points wait to be batched,
  // data points per request, data points buffered per collector (oldest dropped beyond) and the
  // request timeout.
  OTLP_EXPORT_ENABLED: booleanish.default(true),
  OTLP_EXPORT_INTERVAL_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),
  OTLP_EXPORT_MAX_BATCH: z.coerce.number().int().min(1).max(100_000).default(1_000),
  OTLP_EXPORT_MAX_QUEUE: z.coerce.number().int().min(100).max(1_000_000).default(20_000),
  OTLP_EXPORT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
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
  // Probe locations (#91), server side: a location is marked offline (and its admins emailed) when
  // its agent has not called in for this many seconds; requests per minute per location token.
  PROBE_OFFLINE_AFTER: z.coerce.number().int().min(30).max(86_400).default(180),
  PROBE_RATE_LIMIT: z.coerce.number().int().min(0).default(600),
  // Probe agent (MARMOT_ROLE=probe): the Marmot server to call (outbound HTTPS only) and the
  // location's token. Checks run WORKER_CONCURRENCY at a time.
  MARMOT_URL: z.string().url().optional(),
  MARMOT_PROBE_TOKEN: z.string().trim().optional(),
  // Skip the Redis side effects of the `monitors` hooks (tests without Redis).
  MARMOT_DISABLE_ENGINE_HOOKS: booleanish.default(false),

  // Management API (#115): requests per minute per organization API key, and how many of them may
  // be writes (POST/PUT/PATCH/DELETE). 0 turns the respective limit off.
  API_KEY_RATE_LIMIT: z.coerce.number().int().min(0).default(600),
  API_KEY_WRITE_RATE_LIMIT: z.coerce.number().int().min(0).default(60),

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

/**
 * Server roles need the database and the Payload secret; a probe agent talks to Marmot over HTTPS
 * only and needs its URL and token instead.
 */
const requireRoleVariables = (value: z.infer<typeof schema>, ctx: z.RefinementCtx) => {
  const missing = (path: keyof z.infer<typeof schema>, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message })
  if (value.MARMOT_ROLE === 'probe') {
    if (!value.MARMOT_URL) missing('MARMOT_URL', 'required for MARMOT_ROLE=probe')
    if (!value.MARMOT_PROBE_TOKEN) missing('MARMOT_PROBE_TOKEN', 'required for MARMOT_ROLE=probe')
    return
  }
  if (value.PAYLOAD_SECRET.length < 16) {
    missing('PAYLOAD_SECRET', 'PAYLOAD_SECRET must be at least 16 characters')
  }
  if (!value.DATABASE_URL) missing('DATABASE_URL', 'DATABASE_URL is required')
}

const validatedSchema = schema.superRefine(requireRoleVariables)

export type Env = z.infer<typeof schema>

let cached: Env | undefined

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = validatedSchema.safeParse(source)
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
export const runsRole = (role: Exclude<Env['MARMOT_ROLE'], 'all' | 'probe'>) =>
  env.MARMOT_ROLE === 'all' || env.MARMOT_ROLE === role
