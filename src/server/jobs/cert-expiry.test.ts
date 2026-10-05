import { describe, expect, it, vi } from 'vitest'

import type { CertificateInfo, TlsInfo } from '@/server/engine/tls'
import { certExpiryMessage, notifyCertExpiry } from './cert-expiry'
import { createMemorySentHistory, sortedThresholds } from './expiry-history'

const cert = (
  subjectCN: string,
  daysRemaining: number,
  certType: CertificateInfo['certType'],
  issuerCertificate: CertificateInfo | null = null,
): CertificateInfo => ({
  subject: { CN: subjectCN },
  issuer: {},
  subjectCN,
  issuerCN: null,
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2027-01-01T00:00:00.000Z',
  daysRemaining,
  fingerprint: `${subjectCN}-f`,
  fingerprint256: `${subjectCN}-f256`,
  serialNumber: null,
  validFor: [],
  certType,
  issuerCertificate,
})

const tlsInfo = (leaf: CertificateInfo): TlsInfo => ({
  valid: true,
  certInfo: leaf,
  hostnameMatch: true,
  authorizationError: null,
  checkedAt: '2026-10-05T00:00:00.000Z',
})

const monitor = { id: 7, name: 'Shop', url: 'https://shop.example.com' }

function setup(leafDays: number, options: { interDays?: number; rootDays?: number } = {}) {
  const root = cert('Root CA', options.rootDays ?? 3000, 'root CA')
  const inter = cert('Inter CA', options.interDays ?? 500, 'intermediate CA', root)
  const leaf = cert('shop.example.com', leafDays, 'server', inter)
  const history = createMemorySentHistory()
  const sent: string[] = []
  const send = vi.fn(async (message: string) => {
    sent.push(message)
    return true
  })
  return { root, inter, leaf, history, sent, send }
}

describe('sortedThresholds', () => {
  it('sorts ascending, drops duplicates and junk', () => {
    expect(sortedThresholds([21, 7, 14, 7, -1, Number.NaN])).toEqual([7, 14, 21])
  })
})

describe('notifyCertExpiry', () => {
  const notifyDays = [7, 14, 21]
  const knownRoots = new Set<string>()

  it('sends nothing while the chain is comfortably valid', async () => {
    const { leaf, history, send } = setup(90)
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    expect(notices).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('fires the tightest matching threshold once, and dedupes the looser ones', async () => {
    const { leaf, history, send, sent } = setup(10)
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      targetDays: 14,
      daysRemaining: 10,
      subjectCN: 'shop.example.com',
      certType: 'server',
    })
    expect(sent).toEqual([
      '[Shop][https://shop.example.com] server certificate shop.example.com will expire in 10 days',
    ])
    expect(history.rows).toEqual([{ type: 'certificate', monitorId: '7', days: 14 }])

    // Same certificate on the next beat: nothing new.
    const again = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    expect(again).toEqual([])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('escalates when a tighter threshold is crossed later', async () => {
    const { leaf, history, send } = setup(10)
    await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    const closer = { ...leaf, daysRemaining: 5 }
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(closer),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    expect(notices.map((n) => n.targetDays)).toEqual([7])
    expect(history.rows.map((r) => r.days).sort()).toEqual([14, 7])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('fires again after the history was reset (new certificate seen)', async () => {
    const { leaf, history, send } = setup(10)
    await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    await history.clear('certificate', monitor.id)
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    expect(notices).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not record the threshold when every channel failed', async () => {
    const { leaf, history } = setup(10)
    const send = vi.fn(async () => false)
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    expect(notices).toEqual([])
    expect(history.rows).toEqual([])
    // Retried on the next beat.
    const ok = vi.fn(async () => true)
    await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send: ok,
      knownRoots,
    })
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('warns about an intermediate that expires before the leaf', async () => {
    const { leaf, history, send, sent } = setup(200, { interDays: 6 })
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots,
    })
    expect(notices.map((n) => [n.targetDays, n.subjectCN])).toEqual([[7, 'Inter CA']])
    expect(sent[0]).toBe(
      '[Shop][https://shop.example.com] intermediate CA certificate Inter CA will expire in 6 days',
    )
  })

  it('skips certificates of the trust store', async () => {
    const { leaf, root, history, send } = setup(200, { rootDays: 2 })
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays,
      history,
      send,
      knownRoots: new Set([root.fingerprint256]),
    })
    expect(notices).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('treats unsorted thresholds the same as sorted ones', async () => {
    const { leaf, history, send } = setup(10)
    const notices = await notifyCertExpiry({
      monitor,
      tlsInfo: tlsInfo(leaf),
      notifyDays: [21, 7, 14],
      history,
      send,
      knownRoots,
    })
    expect(notices.map((n) => n.targetDays)).toEqual([14])
  })

  it('ignores captures without a certificate', async () => {
    const { history, send } = setup(1)
    const empty: TlsInfo = {
      valid: false,
      certInfo: null,
      hostnameMatch: null,
      authorizationError: 'x',
      checkedAt: 'now',
    }
    expect(
      await notifyCertExpiry({ monitor, tlsInfo: empty, notifyDays, history, send, knownRoots }),
    ).toEqual([])
    expect(
      await notifyCertExpiry({ monitor, tlsInfo: null, notifyDays, history, send, knownRoots }),
    ).toEqual([])
  })

  it('formats the message like Uptime Kuma', () => {
    expect(
      certExpiryMessage(
        { name: 'A', url: null },
        { certType: 'self-signed', subjectCN: null, daysRemaining: -2 },
      ),
    ).toBe('[A][] self-signed certificate (no CN) will expire in -2 days')
  })
})
