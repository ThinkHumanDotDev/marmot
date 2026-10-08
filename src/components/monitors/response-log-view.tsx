'use client'

import { CheckCircle2, ListChecks, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { EmptyState } from '@/components/empty-state'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { parseAssertionResults } from '@/lib/assertion-results'
import { parseRequestTiming } from '@/lib/request-timing'
import type {
  ResponseLogDetail,
  ResponseLogEntry,
  ResponseLogPage,
  ResponseLogQuery,
} from '@/lib/response-log'
import { responseLogApi } from '@/lib/response-log-api'

import { AssertionResultsCard } from './assertion-results-card'
import { statusKey, useMonitorFormat } from './format'
import { TimingWaterfall } from './timing-waterfall'

const ANY = '__any'

/** Status filter options; `failed` covers DOWN beats and failed retries (PENDING). */
const STATUS_OPTIONS = {
  failed: 'down,pending',
  down: 'down',
  degraded: 'degraded',
  pending: 'pending',
  up: 'up',
  maintenance: 'maintenance',
} as const
type StatusOption = keyof typeof STATUS_OPTIONS

const CODE_OPTIONS = ['2xx', '3xx', '4xx', '5xx'] as const
const RANGE_OPTIONS = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
}
type RangeOption = keyof typeof RANGE_OPTIONS

interface ResponseLogViewProps {
  orgId: string
  monitorId: string
  /** Zone of the timestamps (the organization's). */
  timeZone: string
  /** Multi-location monitors (#92): the location chosen in the page's filter (id or `local`). */
  location?: string | null
}

/**
 * Per-check log of a monitor (#97): every check with its status, HTTP status code, response time
 * and trigger, filterable and paged by cursor. A row opens the check in a sheet.
 */
export function ResponseLogView({ orgId, monitorId, timeZone, location }: ResponseLogViewProps) {
  const t = useTranslations('monitors.logs')
  const format = useMonitorFormat(timeZone)

  const [status, setStatus] = React.useState<string>(ANY)
  const [code, setCode] = React.useState<string>(ANY)
  const [trigger, setTrigger] = React.useState<string>(ANY)
  const [range, setRange] = React.useState<string>('24h')
  const [selected, setSelected] = React.useState<ResponseLogEntry | null>(null)
  // Result of the current filters; `key` tells a stale result (filters changed, loading) apart.
  const [result, setResult] = React.useState<{
    key: string
    /** The query the first page was loaded with (`from` resolved), reused by "Load more". */
    query: ResponseLogQuery
    data: ResponseLogPage | null
    error: boolean
  } | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)

  const key = JSON.stringify([status, code, trigger, range, location ?? null])

  React.useEffect(() => {
    let cancelled = false
    const query: ResponseLogQuery = {}
    if (status !== ANY) query.status = STATUS_OPTIONS[status as StatusOption]
    if (code !== ANY) query.statusCode = code
    if (trigger !== ANY) query.trigger = trigger
    // Resolved when the filters change, so "last 24 hours" means from now.
    if (range !== ANY) {
      query.from = new Date(Date.now() - RANGE_OPTIONS[range as RangeOption]).toISOString()
    }
    if (location) query.location = location
    responseLogApi
      .list(orgId, monitorId, query)
      .then((page) => {
        if (!cancelled) setResult({ key, query, data: page, error: false })
      })
      .catch(() => {
        if (!cancelled) setResult({ key, query, data: null, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [orgId, monitorId, key, status, code, trigger, range, location])

  const current = result?.key === key ? result : null
  // While new filters load, the previous rows stay on screen.
  const data = (current ?? result)?.data ?? null
  const loading = current === null || loadingMore
  const error = current?.error ?? false

  const loadMore = async () => {
    if (!current?.data?.nextCursor) return
    const { data: page, query } = current
    setLoadingMore(true)
    try {
      const next = await responseLogApi.list(orgId, monitorId, query, page.nextCursor)
      // Dropped when the filters changed meanwhile.
      setResult((prev) =>
        prev === current
          ? {
              ...current,
              data: { docs: [...page.docs, ...next.docs], nextCursor: next.nextCursor },
            }
          : prev,
      )
    } catch {
      setResult((prev) => (prev === current ? { ...current, error: true } : prev))
    } finally {
      setLoadingMore(false)
    }
  }

  const filtered = status !== ANY || code !== ANY || trigger !== ANY || range !== '24h'
  const clear = () => {
    setStatus(ANY)
    setCode(ANY)
    setTrigger(ANY)
    setRange('24h')
  }

  return (
    <div className="flex flex-col gap-4" data-testid="response-log">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="sr-only">{t('filters.label')}</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="log-status">{t('filters.status')}</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="log-status" className="w-full" data-testid="log-filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('filters.anyStatus')}</SelectItem>
              {(Object.keys(STATUS_OPTIONS) as StatusOption[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`statuses.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="log-code">{t('filters.statusCode')}</Label>
          <Select value={code} onValueChange={setCode}>
            <SelectTrigger id="log-code" className="w-full" data-testid="log-filter-code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('filters.anyStatusCode')}</SelectItem>
              {CODE_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="log-trigger">{t('filters.trigger')}</Label>
          <Select value={trigger} onValueChange={setTrigger}>
            <SelectTrigger id="log-trigger" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('filters.anyTrigger')}</SelectItem>
              <SelectItem value="schedule">{t('triggers.schedule')}</SelectItem>
              <SelectItem value="manual">{t('triggers.manual')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="log-range">{t('filters.range')}</Label>
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger id="log-range" className="w-full" data-testid="log-filter-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RANGE_OPTIONS) as RangeOption[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`ranges.${value}`)}
                </SelectItem>
              ))}
              <SelectItem value={ANY}>{t('ranges.all')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {loading ? t('loading') : t('retention')}
        </p>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clear}>
            {t('clearFilters')}
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('loadFailed')}
        </p>
      )}

      {data && data.docs.length === 0 ? (
        <EmptyState icon={ListChecks} title={filtered ? t('emptyFiltered') : t('empty')} />
      ) : (
        data && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.time')}</TableHead>
                  <TableHead>{t('columns.statusCode')}</TableHead>
                  <TableHead className="text-right">{t('columns.ping')}</TableHead>
                  <TableHead>{t('columns.message')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.docs.map((row) => (
                  <TableRow
                    key={row.id}
                    data-testid="log-row"
                    data-status={row.status}
                    className="cursor-pointer"
                    tabIndex={0}
                    aria-label={t('openCheck', { time: format.dateTime(row.time) })}
                    onClick={() => setSelected(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelected(row)
                      }
                    }}
                  >
                    <TableCell className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <StatusDot status={statusKey(row.status)} className="size-2" />
                        {format.statusText(row.status)}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {format.dateTime(row.time)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.statusCode ?? '–'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      {format.ping(row.ping)}
                    </TableCell>
                    <TableCell className="max-w-80">
                      <span className="flex items-center gap-1.5">
                        {row.trigger === 'manual' && (
                          <Badge variant="secondary" className="text-[10px]">
                            {t('triggers.manual')}
                          </Badge>
                        )}
                        {row.assertions && row.assertions.failed > 0 && (
                          <Badge variant="outline" className="text-[10px] text-destructive">
                            {t('assertionsFailed', { count: row.assertions.failed })}
                          </Badge>
                        )}
                        <span className="truncate">{row.msg}</span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      )}

      {data?.nextCursor && (
        <Button variant="outline" className="self-center" disabled={loading} onClick={loadMore}>
          {t('loadMore')}
        </Button>
      )}

      <ResponseLogSheet
        orgId={orgId}
        monitorId={monitorId}
        entry={selected}
        timeZone={timeZone}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}

/** One check in full: summary, timing waterfall, assertions, probes, headers and body. */
function ResponseLogSheet({
  orgId,
  monitorId,
  entry,
  timeZone,
  onClose,
}: {
  orgId: string
  monitorId: string
  entry: ResponseLogEntry | null
  timeZone: string
  onClose: () => void
}) {
  const t = useTranslations('monitors.logs')
  const format = useMonitorFormat(timeZone)
  const [loaded, setLoaded] = React.useState<{
    id: string
    detail: ResponseLogDetail | null
    error: boolean
  } | null>(null)
  const entryId = entry?.id ?? null

  React.useEffect(() => {
    if (!entryId) return
    let cancelled = false
    responseLogApi
      .get(orgId, monitorId, entryId)
      .then((value) => {
        if (!cancelled) setLoaded({ id: entryId, detail: value, error: false })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: entryId, detail: null, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [orgId, monitorId, entryId])

  const current = loaded && loaded.id === entryId ? loaded : null
  const detail = current?.detail ?? null
  const error = current?.error ?? false

  const timing = detail ? parseRequestTiming(detail.timing) : null
  const assertions = detail ? parseAssertionResults(detail.assertionResults) : []
  const probes = detail ? parseProbes(detail.probes) : []

  return (
    <Sheet open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" data-testid="log-detail">
        <SheetHeader>
          <SheetTitle>{entry ? format.dateTime(entry.time) : ''}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            {entry && (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot status={statusKey(entry.status)} className="size-2" />
                  {format.statusText(entry.status)}
                </span>
                {entry.statusCode !== null && (
                  <Badge variant="outline">{t('httpStatus', { code: entry.statusCode })}</Badge>
                )}
                <Badge variant="secondary">{t(`triggers.${entry.trigger}`)}</Badge>
              </>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-6">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t('detailFailed')}
            </p>
          )}
          {!detail && !error && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
          {detail && (
            <>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">{t('detail.message')}</dt>
                <dd className="break-words">{detail.msg || t('detail.none')}</dd>
                <dt className="text-muted-foreground">{t('detail.responseTime')}</dt>
                <dd className="tabular-nums">{format.ping(detail.ping)}</dd>
                {detail.important && (
                  <>
                    <dt className="text-muted-foreground">{t('detail.important')}</dt>
                    <dd>{t('detail.importantValue')}</dd>
                  </>
                )}
              </dl>

              {timing && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{t('detail.timing')}</h3>
                  <TimingWaterfall timing={timing} ping={detail.ping} />
                </section>
              )}

              {assertions.length > 0 && <AssertionResultsCard results={assertions} />}

              {probes.length > 0 && (
                <section className="flex flex-col gap-2" data-testid="log-probes">
                  <h3 className="text-sm font-medium">{t('detail.probes')}</h3>
                  <div className="rounded-lg border">
                    <Table>
                      <TableBody>
                        {probes.map((probe, index) => (
                          <TableRow key={index}>
                            <TableCell className="w-6">
                              {probe.ok ? (
                                <CheckCircle2
                                  className="size-4 text-status-up-text"
                                  aria-label={t('detail.probeOk')}
                                />
                              ) : (
                                <XCircle
                                  className="size-4 text-destructive"
                                  aria-label={t('detail.probeFailed')}
                                />
                              )}
                            </TableCell>
                            <TableCell className="text-xs whitespace-normal">
                              {probe.location}
                            </TableCell>
                            <TableCell className="text-xs">{probe.msg}</TableCell>
                            <TableCell className="text-right text-xs whitespace-nowrap tabular-nums">
                              {format.ping(probe.latency)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              )}

              <section className="flex flex-col gap-2" data-testid="log-headers">
                <h3 className="text-sm font-medium">{t('detail.headers')}</h3>
                {detail.response?.headers && Object.keys(detail.response.headers).length > 0 ? (
                  <>
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                      {Object.entries(detail.response.headers).map(([name, value]) => (
                        <React.Fragment key={name}>
                          <dt className="text-muted-foreground">{name}</dt>
                          <dd className="break-all">{value}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                    {detail.response.headersTruncated && (
                      <p className="text-xs text-muted-foreground">
                        {t('detail.headersTruncated')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('detail.noHeaders')}</p>
                )}
              </section>

              <section className="flex flex-col gap-2" data-testid="log-body">
                <h3 className="text-sm font-medium">{t('detail.body')}</h3>
                {detail.response?.body ? (
                  <>
                    <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                      {detail.response.body}
                    </pre>
                    {detail.response.bodyTruncated && (
                      <p className="text-xs text-muted-foreground">{t('detail.bodyTruncated')}</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {detail.response?.body === ''
                      ? t('detail.emptyBody')
                      : t('detail.bodyNotStored')}
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface ProbeRow {
  location: string
  ok: boolean
  latency: number | null
  msg: string
}

/** Per-probe results stored on a heartbeat (`heartbeats.probes`); malformed rows are skipped. */
function parseProbes(value: unknown[]): ProbeRow[] {
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const probe = row as Partial<ProbeRow>
    if (typeof probe.location !== 'string' || typeof probe.ok !== 'boolean') return []
    return [
      {
        location: probe.location,
        ok: probe.ok,
        latency: typeof probe.latency === 'number' ? probe.latency : null,
        msg: typeof probe.msg === 'string' ? probe.msg : '',
      },
    ]
  })
}
