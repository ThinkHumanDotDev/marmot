import { Globe, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Monitor } from '@/payload-types'
import { certificateChain, daysUntil, isTlsInfo, type CertificateInfo } from '@/server/engine/tls'
import { isDomainExpiryInfo } from '@/server/jobs/domain-expiry'

import { formatDateTime, formatRelative } from './format'

export type CertificatePanelMonitor = Pick<
  Monitor,
  | 'certInfo'
  | 'domainExpiry'
  | 'expiryNotification'
  | 'domainExpiryNotification'
  | 'ignoreTls'
  | 'type'
>

/** Colour tier for "days remaining" (mirrors Uptime Kuma: red < 7, amber < 21, green otherwise). */
export function expiryTone(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return 'text-muted-foreground'
  if (days < 7) return 'text-status-down'
  if (days < 21) return 'text-status-pending'
  return 'text-status-up'
}

export function formatDaysRemaining(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return '–'
  if (days < 0) return `expired ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} ago`
  if (days === 0) return 'expires today'
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/** Shorten `AA:BB:…` fingerprints for display while keeping the full value in `title`. */
const shortFingerprint = (value: string) =>
  value.length > 29 ? `${value.slice(0, 14)}…${value.slice(-14)}` : value

function Row({
  label,
  children,
  mono,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words', mono && 'font-mono text-xs')}>{children}</dd>
    </div>
  )
}

function CertificateDetails({
  cert,
  valid,
  hostnameMatch,
  authorizationError,
  checkedAt,
  now,
}: {
  cert: CertificateInfo
  valid: boolean
  hostnameMatch: boolean | null
  authorizationError: string | null
  checkedAt: string
  now: Date
}) {
  // Recompute from `validTo` so the panel does not show the age-at-capture figure.
  const days = daysUntil(cert.validTo, now)
  const chain = certificateChain(cert)
  const Icon = valid ? ShieldCheck : days < 0 ? ShieldX : ShieldAlert

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={cn('size-4', valid ? 'text-status-up' : 'text-status-down')} aria-hidden />
        <Badge variant={valid ? 'secondary' : 'destructive'} data-testid="certificate-validity">
          {valid ? 'Valid' : 'Invalid'}
        </Badge>
        {hostnameMatch === false && <Badge variant="outline">Hostname mismatch</Badge>}
        <span className="text-xs text-muted-foreground">
          Checked {formatRelative(checkedAt, now.getTime())}
        </span>
      </div>

      <dl className="flex flex-col gap-2">
        <Row label="Subject">{cert.subjectCN ?? '–'}</Row>
        <Row label="Issuer">
          {cert.issuer.O
            ? `${cert.issuer.O}${cert.issuerCN ? ` · ${cert.issuerCN}` : ''}`
            : (cert.issuerCN ?? '–')}
        </Row>
        <Row label="Valid from">{formatDateTime(cert.validFrom)}</Row>
        <Row label="Valid until">{formatDateTime(cert.validTo)}</Row>
        <Row label="Expires in">
          <span
            className={cn('font-semibold tabular-nums', expiryTone(days))}
            data-testid="certificate-days-remaining"
          >
            {formatDaysRemaining(days)}
          </span>
        </Row>
        <Row label="Fingerprint" mono>
          <span title={cert.fingerprint256}>{shortFingerprint(cert.fingerprint256)}</span>
        </Row>
        {cert.validFor.length > 0 && (
          <Row label="Valid for">
            <span className="font-mono text-xs">{cert.validFor.join(', ')}</span>
          </Row>
        )}
        {authorizationError && (
          <Row label="Error">
            <span className="text-status-down">{authorizationError}</span>
          </Row>
        )}
      </dl>

      {chain.length > 1 && (
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Chain
          </p>
          <ol className="flex flex-col gap-1 text-xs" data-testid="certificate-chain">
            {chain.map((link, index) => {
              const linkDays = daysUntil(link.validTo, now)
              return (
                <li
                  key={link.fingerprint256}
                  className="flex items-baseline justify-between gap-3 rounded-md bg-muted/50 px-2 py-1"
                >
                  <span className="min-w-0 truncate">
                    <span className="text-muted-foreground">{index + 1}.</span>{' '}
                    {link.subjectCN ?? '(no CN)'}{' '}
                    <span className="text-muted-foreground">({link.certType})</span>
                  </span>
                  <span className={cn('shrink-0 tabular-nums', expiryTone(linkDays))}>
                    {formatDaysRemaining(linkDays)}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}

/**
 * TLS certificate (and, when enabled, domain registration) of a monitor as captured by the worker
 * on its last check. Server component: it only reads `monitor.certInfo` / `monitor.domainExpiry`.
 */
export function CertificatePanel({
  monitor,
  now = new Date(),
}: {
  monitor: CertificatePanelMonitor
  now?: Date
}) {
  const tls = isTlsInfo(monitor.certInfo) ? monitor.certInfo : null
  const domain = isDomainExpiryInfo(monitor.domainExpiry) ? monitor.domainExpiry : null
  const isHttps = ['http', 'keyword', 'json-query'].includes(monitor.type)
  const domainDays = domain?.expiresAt ? daysUntil(domain.expiresAt, now) : null

  return (
    <Card className="gap-3" data-testid="certificate-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          Certificate
        </CardTitle>
        <CardDescription>
          Issuer, validity window and days until expiry of the server certificate.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {tls?.certInfo ? (
          <CertificateDetails
            cert={tls.certInfo}
            valid={tls.valid}
            hostnameMatch={tls.hostnameMatch ?? null}
            authorizationError={tls.authorizationError ?? null}
            checkedAt={tls.checkedAt}
            now={now}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="certificate-empty">
            {isHttps
              ? 'No certificate captured yet. It appears after the first check of an https:// URL.'
              : 'Certificates are captured for HTTPS monitors.'}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {monitor.ignoreTls
            ? 'TLS errors are ignored for this monitor, so no expiry warnings are sent.'
            : monitor.expiryNotification
              ? 'Expiry notifications are switched on for this monitor.'
              : 'Turn on "Certificate expiry notification" in the monitor settings to be warned before it expires.'}
        </p>

        {(domain || monitor.domainExpiryNotification) && (
          <div className="border-t pt-4" data-testid="domain-expiry">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Globe className="size-4 text-muted-foreground" aria-hidden />
              Domain registration
            </p>
            {domain ? (
              <dl className="flex flex-col gap-2">
                <Row label="Domain" mono>
                  {domain.domain}
                </Row>
                {domain.expiresAt ? (
                  <>
                    <Row label="Expires on">{formatDateTime(domain.expiresAt)}</Row>
                    <Row label="Expires in">
                      <span
                        className={cn('font-semibold tabular-nums', expiryTone(domainDays))}
                        data-testid="domain-days-remaining"
                      >
                        {formatDaysRemaining(domainDays)}
                      </span>
                    </Row>
                  </>
                ) : (
                  <Row label="Expires on">
                    <span className="text-muted-foreground">
                      {domain.error ?? 'Unknown (no expiration published)'}
                    </span>
                  </Row>
                )}
                <Row label="Checked">{formatRelative(domain.checkedAt, now.getTime())}</Row>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                The registration is looked up via RDAP on the next check.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
