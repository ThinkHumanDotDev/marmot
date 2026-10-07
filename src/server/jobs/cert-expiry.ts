/**
 * TLS certificate expiry warnings.
 *
 * Ported from Uptime Kuma 2.5.5 `server/util-server.js` (`checkCertExpiryNotifications`) and
 * `server/model/monitor.js` (`sendCertNotificationByTargetDays`, `updateTlsInfo`) — Copyright (c)
 * 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * For every threshold in `tlsExpiryNotifyDays` (ascending) the whole chain is inspected; a
 * certificate with `daysRemaining <= threshold` sends `[name][url] <type> certificate <CN> will
 * expire in N days` through the monitor's channels, once per `(monitor, threshold)`. Certificates
 * of the system trust store are skipped (their expiry is the OS vendor's business), and the history
 * is reset when the server presents a new certificate (`certificateChanged` in the worker).
 */
import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'

import { defaultLocale, type Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import { serverTranslator } from '@/server/i18n'
import { certificateChain, type CertificateInfo, type TlsInfo } from '@/server/engine/tls'
import { sortedThresholds, type SentHistoryStore } from './expiry-history'

const log = childLogger('expiry:certificate')

/** Delivers one message to every channel of the monitor; resolves `true` when at least one accepted it. */
export type ExpirySender = (message: string) => Promise<boolean>

export interface CertExpiryNotice {
  targetDays: number
  daysRemaining: number
  subjectCN: string | null
  certType: CertificateInfo['certType']
  message: string
}

export interface NotifyCertExpiryOptions {
  monitor: { id: string | number; name: string; url?: string | null }
  tlsInfo: TlsInfo | null | undefined
  /** `tlsExpiryNotifyDays` from the instance settings. */
  notifyDays: readonly number[]
  history: SentHistoryStore
  send: ExpirySender
  /** Language of the warning (the monitor organization's `settings.language`). */
  locale?: Locale
  /** SHA-256 fingerprints to treat as trusted roots (defaults to the system trust store). */
  knownRoots?: ReadonlySet<string>
}

let systemRoots: Set<string> | undefined

/** SHA-256 fingerprints of Node's bundled root store, parsed once. */
export function systemRootFingerprints(): ReadonlySet<string> {
  if (!systemRoots) {
    systemRoots = new Set()
    for (const pem of tls.rootCertificates) {
      try {
        systemRoots.add(new X509Certificate(pem).fingerprint256)
      } catch {
        // Skip unparsable entries; they only make the "known root" shortcut less complete.
      }
    }
  }
  return systemRoots
}

export function certExpiryMessage(
  monitor: { name: string; url?: string | null },
  cert: Pick<CertificateInfo, 'certType' | 'subjectCN' | 'daysRemaining'>,
  locale: Locale = defaultLocale,
): string {
  const t = serverTranslator(locale)
  return t('notifications.messages.certificateExpiry', {
    name: monitor.name,
    address: monitor.url ?? '',
    // `server`, `intermediate CA`, … are identifiers shared with Kuma; kept as is in every language.
    certType: cert.certType,
    commonName: cert.subjectCN ?? t('notifications.messages.noCommonName'),
    // `count` picks the plural form; `days` is printed as is (no digit grouping, like before).
    count: cert.daysRemaining,
    days: String(cert.daysRemaining),
  })
}

/**
 * Decide which thresholds are due for the chain and send them. Pure apart from the injected
 * `history` and `send`, so the rules are unit-testable without a database.
 */
export async function notifyCertExpiry(
  options: NotifyCertExpiryOptions,
): Promise<CertExpiryNotice[]> {
  const { monitor, tlsInfo, history, send } = options
  const certInfo = tlsInfo?.certInfo
  if (!certInfo || typeof certInfo.daysRemaining !== 'number') return []

  const knownRoots = options.knownRoots ?? systemRootFingerprints()
  const chain = certificateChain(certInfo)
  const sent: CertExpiryNotice[] = []

  for (const targetDays of sortedThresholds(options.notifyDays)) {
    for (const cert of chain) {
      if (knownRoots.has(cert.fingerprint256)) {
        log.debug(
          { monitorId: monitor.id, cn: cert.subjectCN, days: cert.daysRemaining, targetDays },
          'known root certificate; stop walking the chain',
        )
        break
      }
      if (cert.daysRemaining > targetDays) continue

      if (await history.wasSent('certificate', monitor.id, targetDays)) {
        log.debug({ monitorId: monitor.id, targetDays }, 'certificate warning already sent')
        continue
      }
      const message = certExpiryMessage(monitor, cert, options.locale)
      log.info(
        { monitorId: monitor.id, cn: cert.subjectCN, days: cert.daysRemaining, targetDays },
        'sending certificate expiry warning',
      )
      if (!(await send(message))) return sent // every channel failed; retry on the next beat
      await history.markSent('certificate', monitor.id, targetDays)
      sent.push({
        targetDays,
        daysRemaining: cert.daysRemaining,
        subjectCN: cert.subjectCN,
        certType: cert.certType,
        message,
      })
    }
  }
  return sent
}
