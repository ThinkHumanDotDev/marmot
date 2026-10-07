/**
 * Shared plumbing for `/api/orgs/:orgId/monitor-incidents/**`; authentication and authorisation come
 * from `src/server/monitors/http.ts`.
 */
import type { IncidentActionSource } from '@/lib/monitor-incidents'

/** A browser session acts from the dashboard; a request with an API key or JWT header is the API. */
export const actionSource = (request: Request): IncidentActionSource =>
  request.headers.get('authorization') || request.headers.get('x-api-key') ? 'api' : 'dashboard'

/** Optional `note` of an acknowledge/resolve body (trimmed, at most 2000 characters). */
export function readNote(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const note = (body as { note?: unknown }).note
  return typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null
}
