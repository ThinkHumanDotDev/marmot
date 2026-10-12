import { describe, expect, it, vi } from 'vitest'

import {
  buildCtRequestUrls,
  certificateMatchesHost,
  createCtFetcher,
  CT_BACKOFF_MAX_MS,
  CtSourceError,
  ctBackoffMs,
  isAfterBaseline,
  isExpectedIssuer,
  parseCtEntries,
} from './ct-alerts'

const crtSh = (over: Record<string, unknown> = {}) => ({
  issuer_ca_id: 295810,
  issuer_name: "C=US, O=Let's Encrypt, CN=R11",
  common_name: 'example.com',
  name_value: 'example.com\nwww.example.com',
  id: 14_000_000_001,
  entry_timestamp: '2026-10-01T10:00:00.123',
  not_before: '2026-10-01T09:00:00',
  not_after: '2026-12-30T09:00:00',
  serial_number: '04a1b2c3',
  result_count: 2,
  ...over,
})

describe('parseCtEntries', () => {
  it('normalises crt.sh JSON (UTC timestamps, names, link) and merges a precertificate', () => {
    const [cert, ...rest] = parseCtEntries([crtSh(), crtSh({ id: 14_000_000_002 })])
    expect(rest).toHaveLength(0) // same issuer + serial = same certificate
    expect(cert).toMatchObject({
      issuer: "C=US, O=Let's Encrypt, CN=R11",
      commonName: 'example.com',
      names: ['example.com', 'www.example.com'],
      notBefore: '2026-10-01T09:00:00.000Z',
      notAfter: '2026-12-30T09:00:00.000Z',
      loggedAt: '2026-10-01T10:00:00.123Z',
      link: 'https://crt.sh/?id=14000000001',
    })
    expect(cert.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads Cert Spotter issuances', () => {
    const [cert] = parseCtEntries([
      {
        id: '123',
        tbs_sha256: 'AB'.repeat(32),
        cert_sha256: 'cd'.repeat(32),
        dns_names: ['Example.com', '*.example.com'],
        issuer: { friendly_name: 'DigiCert', name: 'C=US, O=DigiCert Inc, CN=DigiCert TLS' },
        not_before: '2026-10-01T00:00:00Z',
        not_after: '2027-10-01T00:00:00Z',
      },
    ])
    expect(cert).toMatchObject({
      fingerprint: 'ab'.repeat(32),
      issuer: 'C=US, O=DigiCert Inc, CN=DigiCert TLS',
      names: ['example.com', '*.example.com'],
      loggedAt: null,
      link: `https://crt.sh/?sha256=${'cd'.repeat(32)}`,
    })
  })

  it('ignores anything that is not a list of entries', () => {
    expect(parseCtEntries({ error: 'nope' })).toEqual([])
    expect(parseCtEntries([null, 'x', {}])).toEqual([])
  })
})

describe('buildCtRequestUrls', () => {
  const crt = 'https://crt.sh/?q={query}&output=json'
  it('queries crt.sh for the hostname and, separately, its subdomains', () => {
    expect(buildCtRequestUrls(crt, 'example.com', false)).toEqual([
      'https://crt.sh/?q=example.com&output=json',
    ])
    expect(buildCtRequestUrls(crt, 'example.com', true)).toEqual([
      'https://crt.sh/?q=example.com&output=json',
      'https://crt.sh/?q=%25.example.com&output=json',
    ])
  })

  it('fills {domain} and {subdomains} templates with one request', () => {
    expect(
      buildCtRequestUrls(
        'https://ct.example.net/issuances?domain={domain}&include_subdomains={subdomains}',
        'example.com',
        true,
      ),
    ).toEqual(['https://ct.example.net/issuances?domain=example.com&include_subdomains=true'])
  })
})

describe('matching', () => {
  it('matches the hostname, and subdomains only when asked', () => {
    const www = { names: ['www.example.com'] }
    expect(certificateMatchesHost({ names: ['example.com'] }, 'example.com', false)).toBe(true)
    expect(certificateMatchesHost(www, 'example.com', false)).toBe(false)
    expect(certificateMatchesHost(www, 'example.com', true)).toBe(true)
    expect(certificateMatchesHost({ names: ['*.example.com'] }, 'example.com', true)).toBe(true)
    expect(certificateMatchesHost({ names: ['badexample.com'] }, 'example.com', true)).toBe(false)
  })

  it('accepts every issuer without a list, otherwise a case-insensitive part of the name', () => {
    const le = "C=US, O=Let's Encrypt, CN=R11"
    expect(isExpectedIssuer(le, [])).toBe(true)
    expect(isExpectedIssuer(le, null)).toBe(true)
    expect(isExpectedIssuer(le, ["let's encrypt"])).toBe(true)
    expect(isExpectedIssuer(le, ['DigiCert', 'Sectigo'])).toBe(false)
  })

  it('compares the log time with the baseline, or notBefore with a day of grace', () => {
    const since = new Date('2026-10-01T12:00:00Z')
    const [cert] = parseCtEntries([crtSh({ entry_timestamp: '2026-10-01T12:00:01' })])
    expect(isAfterBaseline(cert, since)).toBe(true)
    expect(isAfterBaseline({ ...cert, loggedAt: '2026-10-01T11:59:59.000Z' }, since)).toBe(false)
    const noLog = { ...cert, loggedAt: null }
    expect(isAfterBaseline({ ...noLog, notBefore: '2026-10-01T02:00:00.000Z' }, since)).toBe(true)
    expect(isAfterBaseline({ ...noLog, notBefore: '2026-09-29T00:00:00.000Z' }, since)).toBe(false)
  })
})

describe('ctBackoffMs', () => {
  it('doubles from five minutes and stops at a day', () => {
    expect(ctBackoffMs(0)).toBe(0)
    expect(ctBackoffMs(1)).toBe(5 * 60_000)
    expect(ctBackoffMs(3)).toBe(20 * 60_000)
    expect(ctBackoffMs(30)).toBe(CT_BACKOFF_MAX_MS)
  })
})

describe('createCtFetcher', () => {
  it('spaces requests by the rate limit and asks for each URL once', async () => {
    let now = 1_000_000
    const sleep = vi.fn(async (ms: number) => {
      now += ms
    })
    const fetchImpl = vi.fn(async () => Response.json([crtSh()]))
    const fetcher = createCtFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestsPerMinute: 6,
      sleep,
      clock: () => now,
    })
    await fetcher.get('https://ct.test/a')
    await fetcher.get('https://ct.test/a')
    await fetcher.get('https://ct.test/b')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetcher.requests).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(10_000)
  })

  it('reports rate limiting with its Retry-After', async () => {
    const fetcher = createCtFetcher({
      fetchImpl: (async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '120' },
        })) as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    const error = await fetcher.get('https://ct.test/a').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(CtSourceError)
    expect(error).toMatchObject({ status: 429, retryAfterMs: 120_000 })
  })

  it('fails on network errors and answers that are not a list', async () => {
    const down = createCtFetcher({
      fetchImpl: (async () => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    await expect(down.get('https://ct.test/a')).rejects.toThrow(/ECONNRESET/)
    const odd = createCtFetcher({
      fetchImpl: (async () => Response.json({ error: 'x' })) as unknown as typeof fetch,
    })
    await expect(odd.get('https://ct.test/a')).rejects.toThrow(/unexpected answer/)
  })
})
