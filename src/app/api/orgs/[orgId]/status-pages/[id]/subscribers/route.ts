import type { Where } from 'payload'

import {
  SUBSCRIBER_CHANNELS,
  isSubscriberChannel,
  type SubscriberChannel,
} from '@/lib/status-page-subscribers'
import type { StatusPageSubscriber } from '@/payload-types'
import { errorResponse, jsonError, readJson } from '@/server/status-pages/http'
import { errorText } from '@/server/request-locale'
import { ownerContext, ownerSubscriber } from '@/server/status-pages/subscribers/owner'
import { sendWelcome } from '@/server/status-pages/subscribers/signup'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

const PAGE_SIZE = 50

/**
 * GET /api/orgs/:orgId/status-pages/:id/subscribers?page=&q=&channel= — subscribers of the page,
 * newest first, 50 per page, plus confirmed counts per channel. Needs `subscriber:read`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:read')
  if (!owner.ok) return owner.response
  const { payload, user, page } = owner.ctx
  const url = new URL(request.url)
  const pageNumber = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const q = url.searchParams.get('q')?.trim().toLowerCase()
  const channel = url.searchParams.get('channel')

  try {
    const and: Where[] = [{ statusPage: { equals: page.id } }]
    if (q) and.push({ target: { like: q } })
    if (isSubscriberChannel(channel)) and.push({ channel: { equals: channel } })
    const [result, ...counts] = await Promise.all([
      payload.find({
        collection: 'status-page-subscribers',
        where: { and },
        sort: '-createdAt',
        limit: PAGE_SIZE,
        page: pageNumber,
        depth: 0,
        user,
        overrideAccess: false,
      }),
      ...SUBSCRIBER_CHANNELS.map((c) =>
        payload.count({
          collection: 'status-page-subscribers',
          where: {
            and: [
              { statusPage: { equals: page.id } },
              { channel: { equals: c } },
              { confirmedAt: { exists: true } },
            ],
          },
          user,
          overrideAccess: false,
        }),
      ),
    ])
    const confirmed = Object.fromEntries(
      SUBSCRIBER_CHANNELS.map((c, i) => [c, counts[i].totalDocs]),
    ) as Record<SubscriberChannel, number>
    return Response.json({
      docs: (result.docs as StatusPageSubscriber[]).map(ownerSubscriber),
      totalDocs: result.totalDocs,
      page: result.page,
      totalPages: result.totalPages,
      confirmed,
    })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/status-pages/:id/subscribers — `{ channel, target, components?, headers? }`.
 * Owner-added subscribers are confirmed at once (no opt-in); webhook and Slack subscribers get a
 * welcome message with their manage link (and the webhook signing secret). Needs `subscriber:manage`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:manage')
  if (!owner.ok) return owner.response
  const { payload, user, page } = owner.ctx
  const body = await readJson(request)
  if (!body) return jsonError(errorText(request, 'invalidJsonBody'), 400)
  if (!isSubscriberChannel(body.channel)) {
    return jsonError(errorText(request, 'subscriberTargetInvalid'), 400)
  }

  try {
    const doc = (await payload.create({
      collection: 'status-page-subscribers',
      data: {
        organization: page.organization,
        statusPage: page.id,
        channel: body.channel,
        target: String(body.target ?? ''),
        components: Array.isArray(body.components) ? body.components.map(String) : [],
        headers: Array.isArray(body.headers)
          ? (body.headers as { name?: unknown; value?: unknown }[]).map((h) => ({
              name: String(h?.name ?? ''),
              value: String(h?.value ?? ''),
            }))
          : [],
        source: 'added_by_owner',
      },
      depth: 0,
      user,
      overrideAccess: false,
    })) as StatusPageSubscriber
    // The secret is only readable with `subscriber:manage`, which the caller holds.
    await sendWelcome(payload, page, doc)
    return Response.json({ doc: ownerSubscriber(doc) }, { status: 201 })
  } catch (error) {
    return errorResponse(error, request)
  }
}
