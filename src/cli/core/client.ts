/**
 * HTTP client for Marmot's management API (`/api/orgs/:orgId/**`, see `/api/openapi.json`). The CLI
 * talks to Marmot only through this client, authenticated with an organization API key (#115).
 * It depends on nothing but `fetch`, so the GitHub Action (#118) can reuse it as is; tests pass a
 * `fetch` that dispatches to the route handlers.
 */

export type Id = string | number

export interface ClientOptions {
  /** Base URL of the Marmot instance, e.g. `https://status.example.com`. */
  url: string
  /** Organization API key (`mk_…`). */
  apiKey: string
  /** Organization id. */
  org: string
  fetch?: typeof fetch
  userAgent?: string
}

export interface ApiIssue {
  path: string
  message: string
}

/** A non-2xx answer (`status` > 0) or a network failure (`status` 0). */
export class ApiError extends Error {
  readonly status: number
  readonly issues: ApiIssue[]

  constructor(status: number, message: string, issues: ApiIssue[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.issues = issues
  }
}

export interface MonitorDoc {
  id: Id
  name: string
  type: string
  key?: string | null
  active?: boolean | null
  parent?: unknown
  status?: {
    lastStatus?: string | null
    lastCheckAt?: string | null
    lastPing?: number | null
    lastMsg?: string | null
  } | null
  [field: string]: unknown
}

export interface NamedDoc {
  id: Id
  name: string
  [field: string]: unknown
}

export interface HeartbeatDoc {
  id: Id
  status: string
  msg?: string | null
  ping?: number | null
  important?: boolean | null
  time: string
}

export interface StatusPageDoc {
  id: Id
  title: string
  slug: string
  published?: boolean | null
  [field: string]: unknown
}

export interface IncidentDoc {
  id: Id
  title: string
  active?: boolean | null
  pinned?: boolean | null
  createdAt?: string
  resolvedAt?: string | null
  updates?: { status?: string | null; message?: string | null; postedAt?: string | null }[] | null
  [field: string]: unknown
}

export interface MaintenanceSummaryDoc {
  id: Id
  title: string
  status?: string
  strategy?: string
  [field: string]: unknown
}

/** `OnDemandCheckResult` of the check endpoints (#98). */
export interface CheckResult {
  status: string
  ok: boolean
  msg: string
  ping: number | null
  startedAt: string
  elapsedMs: number
  statusCode?: number | null
  tls?: { valid: boolean; daysRemaining: number | null; validTo: string | null } | null
  details?: Record<string, unknown>
  recorded?: boolean
  [field: string]: unknown
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

const PAGE_SIZE = 500

export class MarmotClient {
  readonly baseUrl: string
  readonly org: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly userAgent: string

  constructor(options: ClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '')
    this.org = options.org
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? fetch
    this.userAgent = options.userAgent ?? 'marmot-cli'
  }

  /** Calls `/api/orgs/:org<path>` and returns the parsed JSON body. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/orgs/${encodeURIComponent(this.org)}${path}`)
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      'user-agent': this.userAgent,
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (error) {
      const reason = error instanceof Error ? (error.cause ?? error).toString() : String(error)
      throw new ApiError(0, reason)
    }

    const text = await response.text()
    let json: unknown = undefined
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    if (!response.ok) {
      const first = (json as { errors?: { message?: string; data?: { issues?: ApiIssue[] } }[] })
        ?.errors?.[0]
      const message = first?.message ?? (response.statusText || 'HTTP error')
      throw new ApiError(response.status, message, first?.data?.issues ?? [])
    }
    return json as T
  }

  // ---- Monitors ---------------------------------------------------------------------------------

  /** Every monitor of the organization (all pages). */
  async listMonitors(filter: { type?: string; active?: boolean; key?: string } = {}) {
    const monitors: MonitorDoc[] = []
    for (let page = 1; ; page++) {
      const result = await this.request<{ docs: MonitorDoc[]; hasNextPage?: boolean }>(
        'GET',
        '/monitors',
        { query: { limit: PAGE_SIZE, page, ...filter } },
      )
      monitors.push(...result.docs)
      if (!result.hasNextPage) return monitors
    }
  }

  getMonitor(id: Id) {
    return this.request<MonitorDoc>('GET', `/monitors/${encodeURIComponent(String(id))}`)
  }

  createMonitor(body: Record<string, unknown>) {
    return this.request<MonitorDoc>('POST', '/monitors', { body })
  }

  updateMonitor(id: Id, body: Record<string, unknown>) {
    return this.request<MonitorDoc>('PATCH', `/monitors/${encodeURIComponent(String(id))}`, {
      body,
    })
  }

  deleteMonitor(id: Id) {
    return this.request<MonitorDoc>('DELETE', `/monitors/${encodeURIComponent(String(id))}`)
  }

  setMonitorActive(id: Id, active: boolean) {
    const action = active ? 'resume' : 'pause'
    return this.request<unknown>('POST', `/monitors/${encodeURIComponent(String(id))}/${action}`)
  }

  async heartbeats(id: Id, options: { limit?: number; important?: boolean } = {}) {
    const result = await this.request<{ docs: HeartbeatDoc[] }>(
      'GET',
      `/monitors/${encodeURIComponent(String(id))}/heartbeats`,
      { query: { limit: options.limit, important: options.important ? 'true' : undefined } },
    )
    return result.docs
  }

  /** "Check now" (#98). With `wait: false` the server answers 202 at once. */
  checkMonitor(id: Id, options: { wait?: boolean } = {}) {
    return this.request<CheckResult | { jobId: string }>(
      'POST',
      `/monitors/${encodeURIComponent(String(id))}/check`,
      { query: { wait: options.wait === false ? 'false' : undefined } },
    )
  }

  /** Ad-hoc check of an unsaved monitor configuration (#98). */
  adhocCheck(body: Record<string, unknown>) {
    return this.request<CheckResult>('POST', '/checks', { body })
  }

  // ---- Organization resources -------------------------------------------------------------------

  async listNotifications() {
    return (await this.request<{ docs: NamedDoc[] }>('GET', '/notifications')).docs
  }

  async listTags() {
    return (await this.request<{ docs: NamedDoc[] }>('GET', '/tags')).docs
  }

  createTag(name: string) {
    return this.request<NamedDoc>('POST', '/tags', { body: { name } })
  }

  // ---- Status pages, incidents, maintenance -----------------------------------------------------

  async listStatusPages() {
    return (await this.request<{ docs: StatusPageDoc[] }>('GET', '/status-pages')).docs
  }

  async getStatusPage(id: Id) {
    const path = `/status-pages/${encodeURIComponent(String(id))}`
    return (await this.request<{ doc: StatusPageDoc }>('GET', path)).doc
  }

  async listIncidents(pageId: Id) {
    const path = `/status-pages/${encodeURIComponent(String(pageId))}/incidents`
    return (await this.request<{ docs: IncidentDoc[] }>('GET', path)).docs
  }

  async createIncident(pageId: Id, body: Record<string, unknown>) {
    const path = `/status-pages/${encodeURIComponent(String(pageId))}/incidents`
    return (await this.request<{ doc: IncidentDoc }>('POST', path, { body })).doc
  }

  async updateIncident(pageId: Id, incidentId: Id, body: Record<string, unknown>) {
    const path = `/status-pages/${encodeURIComponent(String(pageId))}/incidents/${encodeURIComponent(String(incidentId))}`
    return (await this.request<{ doc: IncidentDoc }>('PATCH', path, { body })).doc
  }

  postIncidentUpdate(pageId: Id, incidentId: Id, body: Record<string, unknown>) {
    const path = `/status-pages/${encodeURIComponent(String(pageId))}/incidents/${encodeURIComponent(String(incidentId))}/updates`
    return this.request<Record<string, unknown>>('POST', path, { body })
  }

  async listMaintenance() {
    return (await this.request<{ docs: MaintenanceSummaryDoc[] }>('GET', '/maintenance')).docs
  }

  createMaintenance(body: Record<string, unknown>) {
    return this.request<MaintenanceSummaryDoc>('POST', '/maintenance', { body })
  }

  // ---- Import -------------------------------------------------------------------------------------

  /** Imports a Marmot export or an Uptime Kuma backup (`ImportReport`). */
  importFile(json: unknown, dryRun: boolean) {
    return this.request<Record<string, unknown>>('POST', '/import', {
      body: json,
      query: { dryRun: dryRun ? '1' : undefined },
    })
  }
}
