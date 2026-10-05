import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import type { BeatLike } from './heartbeat-bar'
import { formatDateTime, statusText } from './format'

export interface EventsPage {
  docs: BeatLike[]
  page: number
  totalPages: number
  totalDocs: number
}

/**
 * Status transitions (heartbeats with `important = true`), newest first, 20 per page. Pagination
 * is plain links on `?page=` so the page stays a server component.
 */
export function ImportantEventsTable({
  events,
  basePath,
}: {
  events: EventsPage
  basePath: string
}) {
  const pageHref = (page: number) => (page <= 1 ? basePath : `${basePath}?page=${page}`)

  return (
    <Card className="gap-3" data-testid="important-events">
      <CardHeader>
        <CardTitle className="text-base">Important events</CardTitle>
        <CardDescription>Every status change, with the message the check returned.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {events.docs.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">
            No status changes recorded yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32 pl-6">Status</TableHead>
                <TableHead className="w-48">Time</TableHead>
                <TableHead className="pr-6">Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.docs.map((beat) => (
                <TableRow key={beat.id}>
                  <TableCell className="pl-6">
                    <span className="inline-flex items-center gap-2">
                      <StatusDot status={beat.status} pulse={false} />
                      {statusText(beat.status)}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDateTime(beat.time)}
                  </TableCell>
                  <TableCell className="max-w-xl truncate pr-6" title={beat.msg ?? undefined}>
                    {beat.msg || <span className="text-muted-foreground">–</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {events.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-6 pt-4 text-xs text-muted-foreground">
            <span>
              Page {events.page} of {events.totalPages} · {events.totalDocs} events
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                asChild={events.page > 1}
                disabled={events.page <= 1}
              >
                {events.page > 1 ? (
                  <Link href={pageHref(events.page - 1)} scroll={false}>
                    <ChevronLeft /> Newer
                  </Link>
                ) : (
                  <>
                    <ChevronLeft /> Newer
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                asChild={events.page < events.totalPages}
                disabled={events.page >= events.totalPages}
              >
                {events.page < events.totalPages ? (
                  <Link href={pageHref(events.page + 1)} scroll={false}>
                    Older <ChevronRight />
                  </Link>
                ) : (
                  <>
                    Older <ChevronRight />
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
