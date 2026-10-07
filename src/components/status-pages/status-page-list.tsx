import { ExternalLink, Globe } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import type * as React from 'react'

import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { StatusPage } from '@/payload-types'

import { publicStatusPagePath } from './api'

export function StatusPageList({
  pages,
  orgSlug,
  emptyAction,
  timeZone,
}: {
  pages: StatusPage[]
  orgSlug: string
  /** Organization time zone the "Updated" dates render in. */
  timeZone: string
  /** Primary call to action for the empty state (the create dialog, for members who may create). */
  emptyAction?: React.ReactNode
}) {
  const t = useTranslations('statusPages.list')
  const format = useFormatter()

  if (pages.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
        action={emptyAction}
      />
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.title')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('columns.publicUrl')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('columns.monitors')}</TableHead>
            <TableHead>{t('columns.status')}</TableHead>
            <TableHead className="hidden text-right lg:table-cell">
              {t('columns.updated')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pages.map((page) => {
            const monitorCount = (page.groups ?? []).reduce(
              (n, g) => n + (g.monitors?.length ?? 0),
              0,
            )
            const href = publicStatusPagePath(page.slug)
            return (
              <TableRow key={page.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/${orgSlug}/status-pages/${page.id}`}
                    className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {page.title}
                  </Link>
                  {page.description && (
                    <p className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                      {page.description}
                    </p>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {page.published ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-sm font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {href}
                      <ExternalLink className="size-3" aria-hidden />
                      <span className="sr-only">{t('opensInNewTab')}</span>
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">{href}</span>
                  )}
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground tabular-nums sm:table-cell">
                  {t('monitorCount', {
                    monitors: monitorCount,
                    groups: page.groups?.length ?? 0,
                  })}
                </TableCell>
                <TableCell>
                  {page.published ? (
                    <Badge className="bg-status-up/15 text-foreground">{t('published')}</Badge>
                  ) : (
                    <Badge variant="secondary">{t('draft')}</Badge>
                  )}
                </TableCell>
                <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">
                  {format.dateTime(new Date(page.updatedAt), 'date', { timeZone })}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
