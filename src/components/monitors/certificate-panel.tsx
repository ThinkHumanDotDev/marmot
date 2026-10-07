import { Globe, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Monitor } from '@/payload-types'
import { certificateChain, daysUntil, isTlsInfo, type CertificateInfo } from '@/server/engine/tls'
import { isDomainExpiryInfo } from '@/server/jobs/domain-expiry'

import { useMonitorFormat } from './format'

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

/** "12 days", "expires today", "expired 3 days ago". */
function useDaysRemaining(): (days: number | null | undefined) => string {
  const t = useTranslations('monitors.certificate')
  return (days) => {
    if (days === null || days === undefined || !Number.isFinite(days)) return '–'
    if (days < 0) return t('expiredAgo', { count: Math.abs(days) })
    if (days === 0) return t('expiresToday')
    return t('days', { count: days })
  }
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
  timeZone,
}: {
  cert: CertificateInfo
  valid: boolean
  hostnameMatch: boolean | null
  authorizationError: string | null
  checkedAt: string
  now: Date
  timeZone?: string
}) {
  const t = useTranslations('monitors.certificate')
  const format = useMonitorFormat(timeZone)
  const formatDaysRemaining = useDaysRemaining()
  // Recompute from `validTo` so the panel does not show the age-at-capture figure.
  const days = daysUntil(cert.validTo, now)
  const chain = certificateChain(cert)
  const Icon = valid ? ShieldCheck : days < 0 ? ShieldX : ShieldAlert

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={cn('size-4', valid ? 'text-status-up' : 'text-status-down')} aria-hidden />
        <Badge variant={valid ? 'secondary' : 'destructive'} data-testid="certificate-validity">
          {valid ? t('valid') : t('invalid')}
        </Badge>
        {hostnameMatch === false && <Badge variant="outline">{t('hostnameMismatch')}</Badge>}
        <span className="text-xs text-muted-foreground">
          {t('checked', { when: format.relative(checkedAt, now.getTime()) })}
        </span>
      </div>

      <dl className="flex flex-col gap-2">
        <Row label={t('subject')}>{cert.subjectCN ?? '–'}</Row>
        <Row label={t('issuer')}>
          {cert.issuer.O
            ? `${cert.issuer.O}${cert.issuerCN ? ` · ${cert.issuerCN}` : ''}`
            : (cert.issuerCN ?? '–')}
        </Row>
        <Row label={t('validFrom')}>{format.dateTime(cert.validFrom)}</Row>
        <Row label={t('validUntil')}>{format.dateTime(cert.validTo)}</Row>
        <Row label={t('expiresIn')}>
          <span
            className={cn('font-semibold tabular-nums', expiryTone(days))}
            data-testid="certificate-days-remaining"
          >
            {formatDaysRemaining(days)}
          </span>
        </Row>
        <Row label={t('fingerprint')} mono>
          <span title={cert.fingerprint256}>{shortFingerprint(cert.fingerprint256)}</span>
        </Row>
        {cert.validFor.length > 0 && (
          <Row label={t('validFor')}>
            <span className="font-mono text-xs">{cert.validFor.join(', ')}</span>
          </Row>
        )}
        {authorizationError && (
          <Row label={t('error')}>
            <span className="text-status-down">{authorizationError}</span>
          </Row>
        )}
      </dl>

      {chain.length > 1 && (
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('chain')}
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
                    {link.subjectCN ?? t('noCommonName')}{' '}
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
  timeZone,
}: {
  monitor: CertificatePanelMonitor
  now?: Date
  /** Zone of the validity dates (the organization's). */
  timeZone?: string
}) {
  const t = useTranslations('monitors.certificate')
  const format = useMonitorFormat(timeZone)
  const formatDaysRemaining = useDaysRemaining()
  const tls = isTlsInfo(monitor.certInfo) ? monitor.certInfo : null
  const domain = isDomainExpiryInfo(monitor.domainExpiry) ? monitor.domainExpiry : null
  const isHttps = ['http', 'keyword', 'json-query'].includes(monitor.type)
  const domainDays = domain?.expiresAt ? daysUntil(domain.expiresAt, now) : null

  return (
    <Card className="gap-3" data-testid="certificate-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
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
            timeZone={timeZone}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="certificate-empty">
            {isHttps ? t('emptyHttps') : t('emptyOther')}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {monitor.ignoreTls
            ? t('tlsIgnored')
            : monitor.expiryNotification
              ? t('notificationsOn')
              : t('notificationsOff')}
        </p>

        {(domain || monitor.domainExpiryNotification) && (
          <div className="border-t pt-4" data-testid="domain-expiry">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Globe className="size-4 text-muted-foreground" aria-hidden />
              {t('domainTitle')}
            </p>
            {domain ? (
              <dl className="flex flex-col gap-2">
                <Row label={t('domain')} mono>
                  {domain.domain}
                </Row>
                {domain.expiresAt ? (
                  <>
                    <Row label={t('expiresOn')}>{format.dateTime(domain.expiresAt)}</Row>
                    <Row label={t('expiresIn')}>
                      <span
                        className={cn('font-semibold tabular-nums', expiryTone(domainDays))}
                        data-testid="domain-days-remaining"
                      >
                        {formatDaysRemaining(domainDays)}
                      </span>
                    </Row>
                  </>
                ) : (
                  <Row label={t('expiresOn')}>
                    <span className="text-muted-foreground">
                      {domain.error ?? t('domainUnknown')}
                    </span>
                  </Row>
                )}
                <Row label={t('domainChecked')}>
                  {format.relative(domain.checkedAt, now.getTime())}
                </Row>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{t('domainPending')}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
