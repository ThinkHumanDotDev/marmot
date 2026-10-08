/**
 * The fixed demo dataset (#159): what every reset recreates. Plain data only (no Payload, no
 * database), because the check simulator (`./simulate.ts`) reads the monitor profiles from here and
 * runs inside the worker's check path.
 *
 * Every target lives under reserved names (`example.com`, RFC 2606; `.invalid`; 192.0.2.0/24,
 * RFC 5737): nothing here points at a real third party, and demo mode never connects anyway.
 * Times are offsets in minutes from the reset.
 */
import type { Monitor } from '@/payload-types'

/** How a simulated target behaves (see `simulateOutcome`). */
export interface DemoProfile {
  /** Typical response time in ms (the median outside slow periods). */
  latency: number
  /** Log-normal spread of the response time (0.1 = tight, 0.5 = noisy). */
  spread: number
  /** Probability that one check fails outside an outage (a blip the retries absorb). */
  errorRate: number
  /** Recurring outage: down for `forMinutes` out of every `everyMinutes`. */
  outage?: { everyMinutes: number; forMinutes: number; message: string }
  /** Recurring slowdown: response times multiplied by `factor` (drives the DEGRADED state). */
  slowdown?: { everyMinutes: number; forMinutes: number; factor: number }
  /** Message of a failed check outside outages. */
  failure?: string
}

export const DEFAULT_PROFILE: DemoProfile = {
  latency: 180,
  spread: 0.3,
  errorRate: 0.002,
  failure: 'timeout of 48000ms exceeded',
}

export type DemoRole = 'admin' | 'member' | 'viewer'

/** Colleagues of the demo account. They cannot sign in (random passwords nobody knows). */
export const DEMO_MEMBERS: readonly { email: string; name: string; role: DemoRole }[] = [
  { email: 'alex.admin@example.com', name: 'Alex Rivera', role: 'admin' },
  { email: 'sam.member@example.com', name: 'Sam Okafor', role: 'member' },
  { email: 'riley.viewer@example.com', name: 'Riley Chen', role: 'viewer' },
]

export const DEMO_ORGANIZATION = {
  name: 'Example Inc.',
  timezone: 'Europe/Berlin',
} as const

export const DEMO_TAGS: readonly { name: string; color: string }[] = [
  { name: 'production', color: '#16a34a' },
  { name: 'staging', color: '#d97706' },
  { name: 'customer-facing', color: '#2563eb' },
  { name: 'internal', color: '#64748b' },
  { name: 'team', color: '#9333ea' },
]

/** Simulated probe locations (#91). `latency` is added to every check made from there. */
export const DEMO_LOCATIONS: readonly {
  slug: string
  name: string
  region: string
  latency: number
}[] = [
  { slug: 'frankfurt', name: 'Frankfurt', region: 'eu-central', latency: 0 },
  { slug: 'virginia', name: 'Virginia', region: 'us-east', latency: 85 },
  { slug: 'singapore', name: 'Singapore', region: 'ap-southeast', latency: 160 },
]

/** Hostname the simulated probe agents report (`locations.agent.hostname`). */
export const DEMO_PROBE_HOSTNAME = 'simulated-probe'

export const DEMO_CHANNELS: readonly {
  key: string
  name: string
  type: string
  config: Record<string, unknown>
  isDefault?: boolean
}[] = [
  {
    key: 'slack',
    name: 'Ops Slack (#alerts)',
    type: 'slack',
    config: { webhookUrl: 'https://sink.demo.invalid/slack', channel: '#alerts' },
    isDefault: true,
  },
  {
    key: 'discord',
    name: 'Discord #status',
    type: 'discord',
    config: { webhookUrl: 'https://sink.demo.invalid/discord' },
  },
  {
    key: 'webhook',
    name: 'Incident webhook',
    type: 'webhook',
    config: { url: 'https://sink.demo.invalid/webhook', method: 'POST', contentType: 'json' },
  },
]

type MonitorFields = Partial<
  Omit<Monitor, 'id' | 'organization' | 'tags' | 'notifications' | 'locations' | 'parent'>
>

export interface DemoMonitor {
  /** Stable key (`monitors.key`): links the monitor to its profile and the other seed rows. */
  key: string
  name: string
  type: Monitor['type']
  /** Key of the group monitor it belongs to. */
  parent?: string
  description?: string
  fields?: MonitorFields
  /** `[tag name, value?]`. */
  tags?: readonly (readonly [string, string?])[]
  /** Location slugs (multi-location monitor, #92); the local workers check it too. */
  locations?: readonly string[]
  paused?: boolean
  profile?: DemoProfile
}

/** About twenty monitors of the common types, in three groups. */
export const DEMO_MONITORS: readonly DemoMonitor[] = [
  // Groups first so the children can reference them.
  { key: 'grp-website', name: 'Website', type: 'group', tags: [['customer-facing']] },
  { key: 'grp-api', name: 'Public API', type: 'group', tags: [['customer-facing']] },
  { key: 'grp-infra', name: 'Infrastructure', type: 'group', tags: [['internal']] },

  {
    key: 'marketing-site',
    name: 'Marketing site',
    type: 'http',
    parent: 'grp-website',
    description: 'www.example.com, served from the CDN.',
    fields: { url: 'https://www.example.com/', interval: 60, degradedAfter: 1500 },
    tags: [['production'], ['team', 'web']],
    profile: { latency: 95, spread: 0.25, errorRate: 0.001 },
  },
  {
    key: 'docs-site',
    name: 'Documentation',
    type: 'keyword',
    parent: 'grp-website',
    fields: { url: 'https://docs.example.com/', keyword: 'Getting started', interval: 120 },
    tags: [['production'], ['team', 'web']],
    profile: { latency: 140, spread: 0.3, errorRate: 0.002 },
  },
  {
    key: 'status-blog',
    name: 'Engineering blog',
    type: 'http',
    parent: 'grp-website',
    fields: { url: 'https://blog.example.com/', interval: 300 },
    tags: [['production']],
    profile: { latency: 260, spread: 0.35, errorRate: 0.004 },
  },
  {
    key: 'api-gateway',
    name: 'API gateway',
    type: 'http',
    parent: 'grp-api',
    description: 'Checked from three probe locations; DOWN when half of them agree.',
    fields: {
      url: 'https://api.example.com/health',
      interval: 60,
      degradedAfter: 800,
      quorum: 'half',
      includeLocal: true,
    },
    tags: [['production'], ['team', 'platform']],
    locations: ['frankfurt', 'virginia', 'singapore'],
    profile: {
      latency: 120,
      spread: 0.3,
      errorRate: 0.002,
      slowdown: { everyMinutes: 720, forMinutes: 25, factor: 7 },
    },
  },
  {
    key: 'auth-service',
    name: 'Auth service',
    type: 'json-query',
    parent: 'grp-api',
    fields: {
      url: 'https://auth.example.com/healthz',
      jsonPath: 'status',
      jsonPathOperator: '==',
      expectedValue: 'ok',
      interval: 60,
    },
    tags: [['production'], ['team', 'identity']],
    profile: { latency: 75, spread: 0.2, errorRate: 0.001 },
  },
  {
    key: 'payments-api',
    name: 'Payments API',
    type: 'http',
    parent: 'grp-api',
    description: 'Slow during the nightly settlement batch: shows the degraded state.',
    fields: { url: 'https://payments.example.com/v2/ping', interval: 60, degradedAfter: 900 },
    tags: [['production'], ['team', 'payments']],
    profile: {
      latency: 340,
      spread: 0.35,
      errorRate: 0.003,
      slowdown: { everyMinutes: 240, forMinutes: 40, factor: 3.5 },
    },
  },
  {
    key: 'search-api',
    name: 'Search API',
    type: 'http',
    parent: 'grp-api',
    description: 'Flaps on purpose: down a few minutes every two hours.',
    fields: { url: 'https://search.example.com/health', interval: 60, maxRetries: 1 },
    tags: [['production'], ['team', 'search']],
    locations: ['frankfurt', 'virginia', 'singapore'],
    profile: {
      latency: 210,
      spread: 0.4,
      errorRate: 0.004,
      failure: 'Request failed with status code 502',
      outage: {
        everyMinutes: 120,
        forMinutes: 6,
        message: 'connect ECONNREFUSED 192.0.2.17:443',
      },
    },
  },
  {
    key: 'webhooks-ws',
    name: 'Realtime gateway',
    type: 'websocket-upgrade',
    parent: 'grp-api',
    fields: { url: 'wss://realtime.example.com/socket', interval: 120 },
    tags: [['production']],
    profile: { latency: 160, spread: 0.3, errorRate: 0.002 },
  },
  {
    key: 'primary-db',
    name: 'Primary database',
    type: 'postgres',
    parent: 'grp-infra',
    fields: {
      databaseConnectionString: 'postgres://monitor@db.example.com:5432/app',
      databaseQuery: 'SELECT 1',
      interval: 60,
    },
    tags: [['production'], ['team', 'platform']],
    profile: { latency: 6, spread: 0.4, errorRate: 0.0005 },
  },
  {
    key: 'cache',
    name: 'Session cache',
    type: 'redis',
    parent: 'grp-infra',
    fields: { databaseConnectionString: 'redis://cache.example.com:6379', interval: 60 },
    tags: [['production']],
    profile: { latency: 2, spread: 0.3, errorRate: 0.0005 },
  },
  {
    key: 'queue',
    name: 'Message broker',
    type: 'port',
    parent: 'grp-infra',
    fields: { hostname: 'mq.example.com', port: 5672, interval: 60 },
    tags: [['production'], ['internal']],
    profile: { latency: 4, spread: 0.3, errorRate: 0.001 },
  },
  {
    key: 'dns',
    name: 'DNS (example.com)',
    type: 'dns',
    parent: 'grp-infra',
    fields: {
      hostname: 'example.com',
      dnsResolveServer: '192.0.2.53',
      dnsResolveType: 'A',
      port: 53,
      interval: 300,
    },
    tags: [['production']],
    profile: { latency: 18, spread: 0.35, errorRate: 0.001 },
  },
  {
    key: 'edge-router',
    name: 'Edge router',
    type: 'ping',
    parent: 'grp-infra',
    fields: { hostname: '192.0.2.1', interval: 60 },
    tags: [['internal']],
    profile: { latency: 11, spread: 0.2, errorRate: 0.001 },
  },
  {
    key: 'mail',
    name: 'Mail relay',
    type: 'smtp',
    parent: 'grp-infra',
    fields: { hostname: 'mail.example.com', port: 587, smtpSecurity: 'starttls', interval: 300 },
    tags: [['internal']],
    profile: { latency: 90, spread: 0.3, errorRate: 0.002 },
  },
  {
    key: 'ntp',
    name: 'Time server',
    type: 'ntp',
    parent: 'grp-infra',
    fields: { hostname: 'time.example.com', port: 123, interval: 300 },
    tags: [['internal']],
    profile: { latency: 24, spread: 0.3, errorRate: 0.001 },
  },
  {
    key: 'staging-api',
    name: 'Staging API',
    type: 'http',
    description: 'Under maintenance while the staging environment is rebuilt.',
    fields: { url: 'https://staging-api.example.com/health', interval: 120 },
    tags: [['staging']],
    profile: { latency: 230, spread: 0.4, errorRate: 0.01 },
  },
  {
    key: 'nightly-backup',
    name: 'Nightly backup',
    type: 'push',
    description: 'Push monitor: the backup job reports in once a day.',
    fields: { interval: 86_400, retryInterval: 3_600 },
    tags: [['internal']],
  },
  {
    key: 'office-vpn',
    name: 'Office VPN',
    type: 'manual',
    description: 'Manual monitor: its status is set by hand.',
    fields: { manualStatus: 'up', interval: 300 },
    tags: [['internal']],
  },
  {
    key: 'legacy-ftp',
    name: 'Legacy FTP',
    type: 'port',
    description: 'Paused: scheduled for decommissioning.',
    fields: { hostname: 'ftp.example.com', port: 21, interval: 300 },
    tags: [['internal']],
    paused: true,
    profile: { latency: 40, spread: 0.3, errorRate: 0.001 },
  },
]

/** A row of a status page group: a monitor (by key) or a static component. */
export type DemoStatusRow =
  { monitor: string; name?: string } | { static: string; description?: string }

export interface DemoStatusPage {
  key: string
  slug: string
  title: string
  description: string
  groups: readonly { name: string; rows: readonly DemoStatusRow[] }[]
}

export const DEMO_STATUS_PAGES: readonly DemoStatusPage[] = [
  {
    key: 'public',
    slug: 'example-status',
    title: 'Example Inc. Status',
    description: 'Live status of the Example Inc. website and API.',
    groups: [
      {
        name: 'Website',
        rows: [
          { monitor: 'marketing-site', name: 'Website' },
          { monitor: 'docs-site', name: 'Documentation' },
        ],
      },
      {
        name: 'API',
        rows: [
          { monitor: 'api-gateway', name: 'REST API' },
          { monitor: 'auth-service', name: 'Sign-in' },
          { monitor: 'payments-api', name: 'Payments' },
          { monitor: 'search-api', name: 'Search' },
        ],
      },
      {
        name: 'Support',
        rows: [{ static: 'Customer support', description: 'Email and chat support.' }],
      },
    ],
  },
  {
    key: 'internal',
    slug: 'example-internal',
    title: 'Example Inc. Platform',
    description: 'Internal services, for the engineering team.',
    groups: [
      {
        name: 'Data',
        rows: [{ monitor: 'primary-db' }, { monitor: 'cache' }, { monitor: 'queue' }],
      },
      {
        name: 'Network',
        rows: [{ monitor: 'dns' }, { monitor: 'edge-router' }, { monitor: 'mail' }],
      },
    ],
  },
]

type Impact = 'operational' | 'degraded_performance' | 'partial_outage' | 'major_outage'
type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'

export interface DemoIncident {
  page: string
  title: string
  pinned?: boolean
  updates: readonly {
    status: IncidentStatus
    /** Minutes before the reset. */
    minutesAgo: number
    message: string
    /** Monitor keys of the page's rows and their impact. */
    components?: readonly (readonly [string, Impact])[]
  }[]
}

export const DEMO_INCIDENTS: readonly DemoIncident[] = [
  {
    page: 'public',
    title: 'Elevated error rates on search',
    pinned: true,
    updates: [
      {
        status: 'investigating',
        minutesAgo: 50,
        message: 'Some search requests fail with HTTP 502. We are investigating.',
        components: [['search-api', 'partial_outage']],
      },
      {
        status: 'identified',
        minutesAgo: 20,
        message:
          'A failing node in the search cluster drops connections. We are replacing it; ' +
          'results may be incomplete until then.',
        components: [['search-api', 'degraded_performance']],
      },
    ],
  },
  {
    page: 'public',
    title: 'Payment confirmations delayed',
    updates: [
      {
        status: 'investigating',
        minutesAgo: 3 * 24 * 60 + 95,
        message: 'Payment confirmations take longer than usual to arrive.',
        components: [['payments-api', 'degraded_performance']],
      },
      {
        status: 'identified',
        minutesAgo: 3 * 24 * 60 + 70,
        message: 'Our payment provider reports a backlog in their webhook queue.',
      },
      {
        status: 'monitoring',
        minutesAgo: 3 * 24 * 60 + 30,
        message: 'The backlog is cleared and confirmations are on time again. Monitoring.',
        components: [['payments-api', 'operational']],
      },
      {
        status: 'resolved',
        minutesAgo: 3 * 24 * 60,
        message: 'Resolved. No payments were lost; delayed confirmations were all delivered.',
      },
    ],
  },
  {
    page: 'internal',
    title: 'Database failover',
    updates: [
      {
        status: 'investigating',
        minutesAgo: 9 * 24 * 60 + 40,
        message: 'The primary database stopped accepting writes.',
        components: [['primary-db', 'major_outage']],
      },
      {
        status: 'resolved',
        minutesAgo: 9 * 24 * 60 + 25,
        message: 'Failed over to the replica. Root cause: a full disk on the old primary.',
      },
    ],
  },
]

export interface DemoMaintenance {
  title: string
  description: string
  strategy: 'manual' | 'single' | 'recurring-weekday'
  /** Single windows: start and end in minutes from the reset. */
  window?: { startIn: number; endIn: number }
  weekdays?: readonly ('0' | '1' | '2' | '3' | '4' | '5' | '6')[]
  timeRange?: { start: string; end: string }
  monitors: readonly string[]
  pages: readonly string[]
}

export const DEMO_MAINTENANCE: readonly DemoMaintenance[] = [
  {
    title: 'Staging environment rebuild',
    description: 'The staging stack is being rebuilt from scratch.',
    strategy: 'manual',
    monitors: ['staging-api'],
    pages: [],
  },
  {
    title: 'Database upgrade to PostgreSQL 17',
    description: 'Writes are paused for up to 30 minutes during the switchover.',
    strategy: 'single',
    window: { startIn: 26 * 60, endIn: 28 * 60 },
    monitors: ['primary-db'],
    pages: ['public', 'internal'],
  },
  {
    title: 'Weekly patch window',
    description: 'Operating system updates, one host at a time.',
    strategy: 'recurring-weekday',
    weekdays: ['0'],
    timeRange: { start: '03:00', end: '04:00' },
    monitors: ['edge-router', 'mail'],
    pages: ['internal'],
  },
]

/** Resolved on-call incidents (#100) for the monitor incident history. */
export const DEMO_MONITOR_INCIDENTS: readonly {
  monitor: string
  cause: string
  startedMinutesAgo: number
  acknowledgedAfter?: number
  resolvedAfter: number
}[] = [
  {
    monitor: 'search-api',
    cause: 'connect ECONNREFUSED 192.0.2.17:443',
    startedMinutesAgo: 26 * 60,
    acknowledgedAfter: 3,
    resolvedAfter: 6,
  },
  {
    monitor: 'payments-api',
    cause: 'Request failed with status code 503',
    startedMinutesAgo: 3 * 24 * 60 + 95,
    acknowledgedAfter: 4,
    resolvedAfter: 21,
  },
  {
    monitor: 'primary-db',
    cause: 'Connection terminated unexpectedly',
    startedMinutesAgo: 9 * 24 * 60 + 40,
    acknowledgedAfter: 2,
    resolvedAfter: 15,
  },
]

const PROFILES = new Map(
  DEMO_MONITORS.filter((m) => m.profile).map((m) => [m.key, m.profile as DemoProfile]),
)

/** The profile of a seeded monitor (by `key`), or `null` for monitors visitors created. */
export const demoProfileFor = (key: string | null | undefined): DemoProfile | null =>
  (key && PROFILES.get(key)) || null
