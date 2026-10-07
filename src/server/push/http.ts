/**
 * HTTP transport of push signals:
 *
 * - `ALL /api/push/:token?status=up|down&msg=&ping=`: success (or failure with `status=down`),
 *   exactly as before;
 * - `ALL /api/push/:token/start|fail|log`: start a run, report a failure, record a log line;
 * - `ALL /api/push/:token/:exitCode`: `0` is a success, anything else (1–255) a failure.
 *
 * Every path takes `msg`, `ping` and `rid` (pairs a start with its finish when runs overlap). The
 * first `PUSH_BODY_LIMIT_BYTES` of a request body are kept as the event log; the limit is announced
 * in the `Ping-Body-Limit` response header (healthchecks.io convention).
 */
import type { Payload } from 'payload'

import {
  PUSH_BODY_LIMIT_BYTES,
  PUSH_MSG_MAX_LENGTH,
  RUN_ID_PATTERN,
  type PushSignalKind,
} from '@/lib/push-schedule'
import { findPushMonitor, parsePushQuery } from './index'
import { ingestPushSignal } from './signals'

/** Parsed signal segment: the kind plus the exit code it carried, or `null` when unknown. */
export function parseSignalSegment(
  segment: string | null | undefined,
): { kind: PushSignalKind; exitCode: number | null } | null {
  if (segment === null || segment === undefined || segment === '') {
    return { kind: 'success', exitCode: null }
  }
  if (segment === 'start' || segment === 'fail' || segment === 'log') {
    return { kind: segment, exitCode: null }
  }
  if (/^\d{1,3}$/.test(segment)) {
    const code = Number(segment)
    if (code > 255) return null
    return { kind: code === 0 ? 'success' : 'fail', exitCode: code }
  }
  return null
}

/**
 * Read at most `limit` bytes of a request body without buffering the rest. Returns the text
 * (UTF-8, an incomplete trailing character dropped) and whether more bytes were sent.
 */
export async function readCappedBody(
  request: Request,
  limit: number = PUSH_BODY_LIMIT_BYTES,
): Promise<{ text: string | null; truncated: boolean }> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) {
    return { text: null, truncated: false }
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    while (size <= limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
    if (size > limit) truncated = true
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(Math.min(size, limit))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= bytes.length) break
    const part = chunk.subarray(0, bytes.length - offset)
    bytes.set(part, offset)
    offset += part.byteLength
  }
  // `stream: true` keeps a multi-byte character cut at the limit out of the output.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes, { stream: truncated })
  return { text: text.length > 0 ? text : null, truncated }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Ping-Body-Limit': String(PUSH_BODY_LIMIT_BYTES) },
  })

/** Handle one push request for `token` and the optional signal path segment. */
export async function handlePushRequest(
  payload: Payload,
  request: Request,
  token: string,
  segment?: string | null,
): Promise<Response> {
  const signal = parseSignalSegment(segment)
  if (!signal) return json({ ok: false, msg: 'Unknown push signal.' }, 404)

  const url = new URL(request.url)
  const query = url.searchParams
  const rid = query.get('rid')?.trim() || null
  if (rid !== null && !RUN_ID_PATTERN.test(rid)) {
    return json({ ok: false, msg: 'Invalid rid: use up to 64 letters, digits, "-" or "_".' }, 400)
  }

  const legacy = segment === null || segment === undefined || segment === ''
  const parsed = parsePushQuery({
    // `status` only applies to the bare token URL; the signal paths say what they mean.
    status: legacy ? query.get('status') : 'up',
    msg: query.get('msg'),
    ping: query.get('ping'),
  })
  if ('error' in parsed) return json({ ok: false, msg: parsed.error }, 400)

  const monitor = await findPushMonitor(payload, token)
  if (!monitor) return json({ ok: false, msg: 'Monitor not found or not active.' }, 404)

  const body = await readCappedBody(request)
  const rawMsg = query.get('msg')?.slice(0, PUSH_MSG_MAX_LENGTH) || null
  await ingestPushSignal(payload, monitor, {
    kind: legacy ? (parsed.status === 'up' ? 'success' : 'fail') : signal.kind,
    // The bare URL keeps its historical `OK` default; signal paths default per kind.
    msg: legacy ? parsed.msg : rawMsg,
    ping: parsed.ping,
    rid,
    exitCode: signal.exitCode,
    body: body.text,
    bodyTruncated: body.truncated,
    source: 'http',
    method: request.method,
  })
  return json({ ok: true })
}
