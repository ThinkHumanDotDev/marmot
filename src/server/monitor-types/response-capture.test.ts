import { describe, expect, it } from 'vitest'

import {
  REDACTED,
  RESPONSE_BODY_LIMIT_BYTES,
  RESPONSE_HEADERS_LIMIT_BYTES,
  responseLogFiltersSchema,
  statusCodeRange,
} from '@/lib/response-log'

import { captureResponse, requestSecrets, truncateUtf8 } from './response-capture'

const encoder = new TextEncoder()

describe('response capture (#97)', () => {
  it('cuts UTF-8 on a character boundary', () => {
    expect(truncateUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false })
    // "é" is two bytes: a cut after 2 bytes must not split it.
    expect(truncateUtf8('aéb', 2)).toEqual({ text: 'a', truncated: true })
    expect(truncateUtf8('aéb', 3)).toEqual({ text: 'aé', truncated: true })
    const big = '€'.repeat(RESPONSE_BODY_LIMIT_BYTES)
    const { text } = truncateUtf8(big, RESPONSE_BODY_LIMIT_BYTES)
    expect(encoder.encode(text).length).toBeLessThanOrEqual(RESPONSE_BODY_LIMIT_BYTES)
    expect(text).not.toContain('�')
  })

  it('collects every non-trivial request header value and the monitor credentials', () => {
    const secrets = requestSecrets(
      {
        accept: 'text/html',
        'content-type': 'application/json',
        authorization: 'Bearer tok-123456',
        'x-api-key': 'key-abcdef',
      },
      {
        basicAuthPass: 'pass-word',
        bearerToken: null,
        oauthClientSecret: 'oauth-secret',
        url: 'https://user:url%20pass@example.com/',
      },
    )
    expect(secrets).toEqual(
      expect.arrayContaining([
        'Bearer tok-123456',
        'tok-123456',
        'key-abcdef',
        'pass-word',
        'oauth-secret',
        'url pass',
      ]),
    )
    expect(secrets).not.toContain('text/html')
    expect(secrets).not.toContain('application/json')
    // Longest first, so the whole header value is replaced before its token part.
    expect(secrets.indexOf('Bearer tok-123456')).toBeLessThan(secrets.indexOf('tok-123456'))
  })

  it('redacts cookies, scrubs echoed secrets and strips NUL bytes', () => {
    const captured = captureResponse(
      {
        statusCode: 401,
        headers: {
          'Content-Type': 'application/json',
          'set-cookie': ['session=abc; HttpOnly', 'other=1'],
          'x-echo': 'got Bearer tok-123456',
          vary: ['accept', 'origin'],
        },
        body: '{"auth":"Bearer tok-123456","raw":"tok-123456","nul":"a\u0000b"}',
      },
      requestSecrets({ authorization: 'Bearer tok-123456' }),
    )
    expect(captured.statusCode).toBe(401)
    expect(captured.headers).toEqual({
      'content-type': 'application/json',
      'set-cookie': REDACTED,
      'x-echo': `got ${REDACTED}`,
      vary: 'accept, origin',
    })
    expect(captured.body).toBe(`{"auth":"${REDACTED}","raw":"${REDACTED}","nul":"a�b"}`)
    expect(JSON.stringify(captured)).not.toContain('tok-123456')
    expect(captured.headersTruncated).toBe(false)
    expect(captured.bodyTruncated).toBe(false)
  })

  it('caps headers at about 8 KB and the body at 16 KB', () => {
    const headers: Record<string, string> = {}
    for (let i = 0; i < 40; i += 1) headers[`x-filler-${i}`] = 'v'.repeat(300)
    const captured = captureResponse({
      statusCode: 200,
      headers,
      body: 'x'.repeat(RESPONSE_BODY_LIMIT_BYTES * 2),
    })
    const size = Object.entries(captured.headers ?? {}).reduce(
      (sum, [name, value]) => sum + name.length + value.length + 4,
      0,
    )
    expect(size).toBeLessThanOrEqual(RESPONSE_HEADERS_LIMIT_BYTES)
    expect(Object.keys(captured.headers ?? {}).length).toBeGreaterThan(20)
    expect(captured.headersTruncated).toBe(true)
    expect(captured.body).toHaveLength(RESPONSE_BODY_LIMIT_BYTES)
    expect(captured.bodyTruncated).toBe(true)
  })
})

describe('response log filters', () => {
  it('parses status lists, status codes and classes', () => {
    expect(statusCodeRange('5xx')).toEqual([500, 599])
    expect(statusCodeRange('503')).toEqual([503, 503])
    expect(statusCodeRange('600')).toBeNull()
    expect(responseLogFiltersSchema.parse({ status: 'down, PENDING' }).status).toEqual([
      'down',
      'pending',
    ])
    expect(responseLogFiltersSchema.safeParse({ status: 'down,nope' }).success).toBe(false)
    expect(responseLogFiltersSchema.safeParse({ statusCode: '5x' }).success).toBe(false)
    expect(responseLogFiltersSchema.safeParse({ trigger: 'push' }).success).toBe(false)
    expect(responseLogFiltersSchema.safeParse({ from: 'yesterday' }).success).toBe(false)
  })
})
