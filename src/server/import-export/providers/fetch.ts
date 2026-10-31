/**
 * HTTP access to the import providers' APIs (#120). Credentials travel only in request headers of
 * calls to the provider's fixed API host; they are never part of URLs, errors or log lines, and
 * nothing here keeps them after the call.
 */

/** `fetch`, injectable so tests drive the providers with recorded fixtures. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type ProviderErrorCode =
  | 'credentials'
  | 'auth'
  | 'notFound'
  | 'unreachable'
  | 'invalidResponse'
  | 'tooMany'

/** A provider API call failed; the code maps to a report message (and an HTTP status). */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly status: number | null = null,
  ) {
    super(`provider request failed: ${code}${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'ProviderError'
  }
}

const TIMEOUT_MS = 20_000
/** Upper bound of pages read from one list endpoint (100 items each on both providers). */
export const MAX_PAGES = 100
/** Upper bound of API calls per import, so a huge account cannot keep a request busy for long. */
export const MAX_REQUESTS = 1_000

export interface ProviderClient {
  /** GET `path` (relative to the API base, or an absolute URL on the same origin) as JSON. */
  get(path: string): Promise<unknown>
}

/** A JSON client bound to one API base URL and the caller's authorization headers. */
export function providerClient(
  fetchImpl: FetchLike,
  baseUrl: string,
  headers: Record<string, string>,
): ProviderClient {
  const origin = new URL(baseUrl).origin
  let requests = 0
  return {
    async get(path) {
      const url = /^https?:\/\//.test(path) ? path : `${baseUrl}${path}`
      // Pagination links come from the response: never send the credentials to another host.
      if (new URL(url).origin !== origin) throw new ProviderError('invalidResponse')
      requests += 1
      if (requests > MAX_REQUESTS) throw new ProviderError('tooMany')
      let response: Response
      try {
        response = await fetchImpl(url, {
          headers: { accept: 'application/json', ...headers },
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch {
        // The underlying error is dropped on purpose: it may echo the request.
        throw new ProviderError('unreachable')
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('auth', response.status)
      }
      if (response.status === 404) throw new ProviderError('notFound', 404)
      if (!response.ok) throw new ProviderError('unreachable', response.status)
      try {
        return await response.json()
      } catch {
        throw new ProviderError('invalidResponse', response.status)
      }
    },
  }
}
