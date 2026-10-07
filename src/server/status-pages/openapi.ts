/**
 * OpenAPI 3.1 description of a status page's public read-only endpoints
 * (`/status/<slug>/api/openapi.json`). The server URL is the page itself (`/status/<slug>` or the
 * root of a custom domain), so every path below is relative to it. These endpoints are a stability
 * contract: breaking changes go under a new version prefix (`/api/v3/…`), see docs/Status-Pages.md.
 */
import type { StatusPage } from '@/payload-types'

import { accessCookieName, PASSWORD_PARAM } from './access'
import type { StatusPageLinks } from './urls'

export const PUBLIC_API_VERSION = '1.0.0'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({
  type: [type, 'null'],
  ...extra,
})

const dateTime = { type: 'string', format: 'date-time' }

const conditional = {
  parameters: [{ $ref: '#/components/parameters/IfNoneMatch' }],
}

const ok = (description: string, contentType: string, schema: Record<string, unknown>) => ({
  description,
  headers: {
    ETag: { $ref: '#/components/headers/ETag' },
    'Cache-Control': { $ref: '#/components/headers/CacheControl' },
  },
  content: { [contentType]: { schema } },
})

const errors = {
  '304': { description: 'Not modified (the `If-None-Match` ETag still matches).' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '404': { $ref: '#/components/responses/NotFound' },
  '429': { $ref: '#/components/responses/TooManyRequests' },
}

const get = (
  operationId: string,
  summary: string,
  response: ReturnType<typeof ok>,
  tags: string[],
  extra: Record<string, unknown> = {},
) => ({
  get: {
    operationId,
    summary,
    tags,
    ...conditional,
    ...extra,
    responses: { '200': response, ...errors },
  },
})

const text = { type: 'string' }

/** Fields incidents and scheduled maintenance share (Statuspage v2). */
const eventProperties = {
  id: text,
  name: text,
  created_at: dateTime,
  updated_at: dateTime,
  monitoring_at: nullable('string', { format: 'date-time' }),
  resolved_at: nullable('string', { format: 'date-time' }),
  shortlink: { type: 'string', format: 'uri' },
  started_at: dateTime,
  page_id: text,
  incident_updates: { type: 'array', items: ref('IncidentUpdate') },
  components: { type: 'array', items: ref('Component') },
}

export function buildOpenApiDocument(
  page: Pick<StatusPage, 'id' | 'title'>,
  links: StatusPageLinks,
): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: page.title,
      version: PUBLIC_API_VERSION,
      description:
        'Public, read-only endpoints of a Marmot status page: feeds, an iCalendar feed of maintenance, ' +
        'Statuspage-compatible JSON (v2) and Markdown. Responses carry a weak ETag (send it back in ' +
        '`If-None-Match` for a 304), `Cache-Control` matched to the page refresh interval, and ' +
        '`Access-Control-Allow-Origin: *`. Errors are RFC 9457 problem details.',
    },
    servers: [{ url: links.page }],
    security: [{}, { password: [] }, { session: [] }],
    tags: [{ name: 'statuspage' }, { name: 'feeds' }, { name: 'markdown' }],
    paths: {
      '/api/v2/summary.json': get(
        'getSummary',
        'Page, components, unresolved incidents, upcoming maintenance and overall status.',
        ok('Summary', 'application/json', ref('Summary')),
        ['statuspage'],
      ),
      '/api/v2/status.json': get(
        'getStatus',
        'Overall status indicator.',
        ok('Status', 'application/json', {
          type: 'object',
          required: ['page', 'status'],
          properties: { page: ref('Page'), status: ref('Status') },
        }),
        ['statuspage'],
      ),
      '/api/v2/components.json': get(
        'getComponents',
        'Every component (groups and their members).',
        ok('Components', 'application/json', {
          type: 'object',
          required: ['page', 'components'],
          properties: { page: ref('Page'), components: { type: 'array', items: ref('Component') } },
        }),
        ['statuspage'],
      ),
      '/api/v2/incidents.json': get(
        'getIncidents',
        'The 50 most recent incidents.',
        ok('Incidents', 'application/json', {
          type: 'object',
          required: ['page', 'incidents'],
          properties: { page: ref('Page'), incidents: { type: 'array', items: ref('Incident') } },
        }),
        ['statuspage'],
      ),
      '/api/v2/scheduled-maintenances.json': get(
        'getScheduledMaintenances',
        'Maintenance occurrences: unfinished ones and those of the last 30 days, newest first.',
        ok('Scheduled maintenances', 'application/json', {
          type: 'object',
          required: ['page', 'scheduled_maintenances'],
          properties: {
            page: ref('Page'),
            scheduled_maintenances: { type: 'array', items: ref('ScheduledMaintenance') },
          },
        }),
        ['statuspage'],
      ),
      '/feed/atom': get(
        'getAtomFeed',
        'Atom 1.0 feed: one entry per incident update and per monitor that is down.',
        ok('Atom feed', 'application/atom+xml', text),
        ['feeds'],
      ),
      '/feed/json': get(
        'getJsonFeed',
        'JSON Feed 1.1: the same items as the Atom feed.',
        ok('JSON Feed', 'application/feed+json', { type: 'object' }),
        ['feeds'],
      ),
      '/rss': get(
        'getRssFeed',
        'RSS 2.0: the same items as the Atom feed.',
        ok('RSS feed', 'application/rss+xml', text),
        ['feeds'],
      ),
      '/maintenance.ics': get(
        'getMaintenanceCalendar',
        'iCalendar (RFC 5545) feed of maintenance windows.',
        ok('Calendar', 'text/calendar', text),
        ['feeds'],
      ),
      '/index.md': get(
        'getPageMarkdown',
        'The page as Markdown (also served as `/status/<slug>.md`).',
        ok('Markdown', 'text/markdown', text),
        ['markdown'],
      ),
      '/incidents/{id}.md': get(
        'getIncidentMarkdown',
        'One incident and its timeline as Markdown.',
        ok('Markdown', 'text/markdown', text),
        ['markdown'],
        {
          parameters: [
            { $ref: '#/components/parameters/IfNoneMatch' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
        },
      ),
      '/llms.txt': get(
        'getLlmsTxt',
        'llms.txt: what this page is and links to every machine-readable view.',
        ok('llms.txt', 'text/plain', text),
        ['markdown'],
      ),
    },
    components: {
      securitySchemes: {
        password: {
          type: 'apiKey',
          in: 'query',
          name: PASSWORD_PARAM,
          description:
            'Password of a protected page. It ends up in URLs and logs; prefer the cookie.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: accessCookieName(page.id),
          description: 'Access cookie set by signing in to a protected page.',
        },
      },
      parameters: {
        IfNoneMatch: {
          name: 'If-None-Match',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        },
      },
      headers: {
        ETag: { schema: { type: 'string' }, description: 'Weak validator of the body.' },
        CacheControl: {
          schema: { type: 'string' },
          description:
            '`public, max-age=<page refresh interval, 30–300 s>, stale-while-revalidate=…`; ' +
            '`private, no-store` for password-protected pages.',
        },
      },
      responses: {
        Unauthorized: {
          description: 'The page is password-protected and the request has no access.',
          content: { 'application/problem+json': { schema: ref('Problem') } },
        },
        NotFound: {
          description: 'No published page (or incident) with this id.',
          content: { 'application/problem+json': { schema: ref('Problem') } },
        },
        TooManyRequests: {
          description: 'Too many wrong passwords; see `Retry-After`.',
          content: { 'application/problem+json': { schema: ref('Problem') } },
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status'],
          properties: {
            type: text,
            title: text,
            status: { type: 'integer' },
            detail: text,
            instance: text,
            code: {
              type: 'string',
              enum: ['not-found', 'login-required', 'invalid-password', 'rate-limited'],
            },
          },
        },
        Page: {
          type: 'object',
          required: ['id', 'name', 'url', 'time_zone', 'updated_at'],
          properties: {
            id: text,
            name: text,
            url: { type: 'string', format: 'uri' },
            time_zone: text,
            updated_at: dateTime,
          },
        },
        Status: {
          type: 'object',
          required: ['indicator', 'description'],
          properties: {
            indicator: { type: 'string', enum: ['none', 'minor', 'major', 'critical'] },
            description: text,
          },
        },
        Component: {
          type: 'object',
          required: ['id', 'name', 'status', 'position', 'group', 'group_id', 'page_id'],
          properties: {
            id: text,
            name: text,
            status: {
              type: 'string',
              enum: [
                'operational',
                'degraded_performance',
                'partial_outage',
                'major_outage',
                'under_maintenance',
              ],
            },
            created_at: dateTime,
            updated_at: dateTime,
            position: { type: 'integer' },
            description: nullable('string'),
            showcase: { type: 'boolean' },
            start_date: nullable('string'),
            group_id: nullable('string'),
            page_id: text,
            group: { type: 'boolean' },
            only_show_if_degraded: { type: 'boolean' },
            components: { type: 'array', items: text },
          },
        },
        AffectedComponent: {
          type: 'object',
          properties: { code: text, name: text, old_status: text, new_status: text },
        },
        IncidentUpdate: {
          type: 'object',
          required: ['id', 'status', 'body', 'incident_id', 'created_at', 'display_at'],
          properties: {
            id: text,
            status: text,
            body: { type: 'string', description: 'Markdown.' },
            incident_id: text,
            created_at: dateTime,
            updated_at: dateTime,
            display_at: dateTime,
            affected_components: nullable('array', { items: ref('AffectedComponent') }),
            deliver_notifications: { type: 'boolean' },
            custom_tweet: { type: 'null' },
            tweet_id: { type: 'null' },
          },
        },
        Incident: {
          type: 'object',
          required: ['id', 'name', 'status', 'impact', 'created_at', 'incident_updates'],
          properties: {
            ...eventProperties,
            status: {
              type: 'string',
              enum: ['investigating', 'identified', 'monitoring', 'resolved', 'postmortem'],
            },
            impact: { type: 'string', enum: ['none', 'minor', 'major', 'critical'] },
          },
        },
        ScheduledMaintenance: {
          type: 'object',
          required: ['id', 'name', 'status', 'impact', 'scheduled_for', 'incident_updates'],
          properties: {
            ...eventProperties,
            status: {
              type: 'string',
              enum: ['scheduled', 'in_progress', 'verifying', 'completed'],
            },
            impact: { const: 'maintenance' },
            scheduled_for: dateTime,
            scheduled_until: nullable('string', { format: 'date-time' }),
          },
        },
        Summary: {
          type: 'object',
          required: ['page', 'components', 'incidents', 'scheduled_maintenances', 'status'],
          properties: {
            page: ref('Page'),
            components: { type: 'array', items: ref('Component') },
            incidents: { type: 'array', items: ref('Incident') },
            scheduled_maintenances: { type: 'array', items: ref('ScheduledMaintenance') },
            status: ref('Status'),
          },
        },
      },
    },
  }
}
