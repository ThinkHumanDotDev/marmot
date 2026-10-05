import { describe, expect, it, vi } from 'vitest'

import {
  domainCandidates,
  domainRenewed,
  extractDomain,
  isDomainExpiryStale,
  lookupDomainExpiry,
  notifyDomainExpiry,
  parseRdapExpiry,
  type DomainExpiryInfo,
} from './domain-expiry'
import { createMemorySentHistory } from './expiry-history'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000 + 3_600_000)

describe('extractDomain', () => {
  it('takes the hostname of HTTP URLs and the hostname field of host monitors', () => {
    expect(
      extractDomain({ type: 'http', url: 'https://www.Example.com:8443/path?q=1', hostname: null }),
    ).toBe('www.example.com')
    expect(
      extractDomain({ type: 'keyword', url: 'http://api.example.org./', hostname: null }),
    ).toBe('api.example.org')
    expect(extractDomain({ type: 'port', url: null, hostname: 'mail.example.net' })).toBe(
      'mail.example.net',
    )
    expect(
      extractDomain({
        type: 'ping',
        url: 'https://ignored.example.com',
        hostname: 'host.example.io',
      }),
    ).toBe('host.example.io')
  })

  it('rejects IPs, local and single-label names, and types without a target', () => {
    expect(extractDomain({ type: 'http', url: 'https://127.0.0.1/', hostname: null })).toBeNull()
    expect(extractDomain({ type: 'http', url: 'https://[::1]:3000/', hostname: null })).toBeNull()
    expect(extractDomain({ type: 'http', url: 'https://localhost/', hostname: null })).toBeNull()
    expect(extractDomain({ type: 'http', url: 'https://intranet/', hostname: null })).toBeNull()
    expect(extractDomain({ type: 'port', url: null, hostname: 'db.internal' })).toBeNull()
    expect(extractDomain({ type: 'port', url: null, hostname: 'nas.local' })).toBeNull()
    expect(extractDomain({ type: 'http', url: 'not a url', hostname: null })).toBeNull()
    expect(
      extractDomain({ type: 'push', url: 'https://example.com', hostname: 'example.com' }),
    ).toBeNull()
  })
})

describe('domainCandidates', () => {
  it('walks up to the registrable domain, never below two labels, at most four tries', () => {
    expect(domainCandidates('www.example.com')).toEqual(['www.example.com', 'example.com'])
    expect(domainCandidates('a.b.c.d.example.co.uk')).toEqual([
      'a.b.c.d.example.co.uk',
      'b.c.d.example.co.uk',
      'c.d.example.co.uk',
      'd.example.co.uk',
    ])
    expect(domainCandidates('example.com')).toEqual(['example.com'])
  })
})

describe('parseRdapExpiry', () => {
  it('returns the expiration event date', () => {
    const date = parseRdapExpiry({
      events: [
        { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
        { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
      ],
    })
    expect(date?.toISOString()).toBe('2027-08-13T04:00:00.000Z')
  })

  it('returns null without an (valid) expiration event', () => {
    expect(
      parseRdapExpiry({ events: [{ eventAction: 'registration', eventDate: '2020-01-01' }] }),
    ).toBeNull()
    expect(
      parseRdapExpiry({ events: [{ eventAction: 'expiration', eventDate: 'soon' }] }),
    ).toBeNull()
    expect(parseRdapExpiry({ events: 'nope' })).toBeNull()
    expect(parseRdapExpiry(null)).toBeNull()
    expect(parseRdapExpiry('string')).toBeNull()
  })
})

describe('lookupDomainExpiry (mocked fetch)', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/rdap+json' },
    })

  it('retries with the parent domain on 404 and reports the registrable domain', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      expect((init?.headers as Record<string, string>).accept).toContain('application/rdap+json')
      if (url.endsWith('/domain/www.example.com')) return json({ errorCode: 404 }, 404)
      return json({ events: [{ eventAction: 'expiration', eventDate: inDays(30).toISOString() }] })
    }) as unknown as typeof fetch

    const info = await lookupDomainExpiry('www.example.com', { fetchImpl, now: NOW })
    expect(calls).toEqual([
      'https://rdap.org/domain/www.example.com',
      'https://rdap.org/domain/example.com',
    ])
    expect(info).toMatchObject({
      host: 'www.example.com',
      domain: 'example.com',
      expiresAt: inDays(30).toISOString(),
      daysRemaining: 30,
      checkedAt: NOW.toISOString(),
      error: null,
    })
  })

  it('reports failures instead of throwing', async () => {
    const notFound = (async () => json({}, 404)) as unknown as typeof fetch
    expect(
      await lookupDomainExpiry('www.example.test', { fetchImpl: notFound, now: NOW }),
    ).toMatchObject({
      domain: 'www.example.test',
      expiresAt: null,
      daysRemaining: null,
      error: 'No RDAP record for example.test',
    })

    const failing = (async () => {
      throw new Error('getaddrinfo ENOTFOUND rdap.org')
    }) as unknown as typeof fetch
    expect((await lookupDomainExpiry('example.com', { fetchImpl: failing, now: NOW })).error).toBe(
      'RDAP request failed: getaddrinfo ENOTFOUND rdap.org',
    )

    const serverError = (async () => json({}, 503)) as unknown as typeof fetch
    expect(
      (await lookupDomainExpiry('example.com', { fetchImpl: serverError, now: NOW })).error,
    ).toBe('RDAP server answered 503')

    const noEvent = (async () => json({ events: [] })) as unknown as typeof fetch
    expect((await lookupDomainExpiry('example.com', { fetchImpl: noEvent, now: NOW })).error).toBe(
      'RDAP record has no expiration event',
    )

    const garbage = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    expect((await lookupDomainExpiry('example.com', { fetchImpl: garbage, now: NOW })).error).toBe(
      'RDAP server returned invalid JSON',
    )
  })
})

describe('cache freshness', () => {
  const info = (ageMs: number, expiresAt: string | null): DomainExpiryInfo => ({
    host: 'www.example.com',
    domain: 'example.com',
    expiresAt,
    daysRemaining: 30,
    checkedAt: new Date(NOW.getTime() - ageMs).toISOString(),
    error: expiresAt ? null : 'boom',
  })
  const hour = 3_600_000

  it('re-checks daily after a success and hourly after a failure', () => {
    expect(isDomainExpiryStale(null, NOW)).toBe(true)
    expect(isDomainExpiryStale(info(2 * hour, inDays(30).toISOString()), NOW)).toBe(false)
    expect(isDomainExpiryStale(info(25 * hour, inDays(30).toISOString()), NOW)).toBe(true)
    expect(isDomainExpiryStale(info(10 * 60_000, null), NOW)).toBe(false)
    expect(isDomainExpiryStale(info(2 * hour, null), NOW)).toBe(true)
    expect(isDomainExpiryStale({ ...info(0, null), checkedAt: 'garbage' }, NOW)).toBe(true)
  })

  it('detects a renewal when the expiry moves later', () => {
    const before = info(0, inDays(10).toISOString())
    expect(domainRenewed(before, info(0, inDays(375).toISOString()))).toBe(true)
    expect(domainRenewed(before, info(0, inDays(10).toISOString()))).toBe(false)
    expect(domainRenewed(before, info(0, null))).toBe(false)
    expect(domainRenewed(null, info(0, inDays(375).toISOString()))).toBe(false)
  })
})

describe('notifyDomainExpiry', () => {
  const monitor = { id: 'm1', name: 'Site', url: 'https://www.example.com', hostname: null }
  const notifyDays = [7, 14, 21]
  const info = (days: number): DomainExpiryInfo => ({
    host: 'www.example.com',
    domain: 'example.com',
    expiresAt: inDays(days).toISOString(),
    daysRemaining: days,
    checkedAt: NOW.toISOString(),
    error: null,
  })

  it('sends the tightest matching threshold once and escalates later', async () => {
    const history = createMemorySentHistory()
    const sent: string[] = []
    const send = vi.fn(async (message: string) => {
      sent.push(message)
      return true
    })

    expect(
      await notifyDomainExpiry({ monitor, info: info(60), notifyDays, history, send, now: NOW }),
    ).toBeNull()

    const first = await notifyDomainExpiry({
      monitor,
      info: info(10),
      notifyDays,
      history,
      send,
      now: NOW,
    })
    expect(first).toMatchObject({ targetDays: 14, daysRemaining: 10, domain: 'example.com' })
    expect(sent).toEqual([
      '[Site][https://www.example.com] Domain name example.com will expire in 10 days',
    ])
    expect(
      await notifyDomainExpiry({ monitor, info: info(10), notifyDays, history, send, now: NOW }),
    ).toBeNull()

    const closer = await notifyDomainExpiry({
      monitor,
      info: info(3),
      notifyDays,
      history,
      send,
      now: NOW,
    })
    expect(closer?.targetDays).toBe(7)
    expect(send).toHaveBeenCalledTimes(2)

    await history.clear('domain', monitor.id)
    expect(
      (await notifyDomainExpiry({ monitor, info: info(3), notifyDays, history, send, now: NOW }))
        ?.targetDays,
    ).toBe(7)
  })

  it('does nothing without a date and keeps retrying while sends fail', async () => {
    const history = createMemorySentHistory()
    const send = vi.fn(async () => false)
    expect(
      await notifyDomainExpiry({
        monitor,
        info: { ...info(3), expiresAt: null },
        notifyDays,
        history,
        send,
        now: NOW,
      }),
    ).toBeNull()
    expect(
      await notifyDomainExpiry({ monitor, info: null, notifyDays, history, send, now: NOW }),
    ).toBeNull()
    expect(send).not.toHaveBeenCalled()

    expect(
      await notifyDomainExpiry({ monitor, info: info(3), notifyDays, history, send, now: NOW }),
    ).toBeNull()
    expect(history.rows).toEqual([])
    expect(send).toHaveBeenCalledTimes(1)
  })
})
