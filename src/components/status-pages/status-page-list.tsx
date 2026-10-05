import { ExternalLink, Globe } from 'lucide-react'
import Link from 'next/link'

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

export function StatusPageList({ pages, orgSlug }: { pages: StatusPage[]; orgSlug: string }) {
  if (pages.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title="No status pages yet"
        description="Publish a status page to share uptime, incidents and maintenance with the people who rely on you."
      />
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Public URL</TableHead>
            <TableHead>Monitors</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Updated</TableHead>
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
                    className="underline-offset-4 hover:underline"
                  >
                    {page.title}
                  </Link>
                  {page.description && (
                    <p className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                      {page.description}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  {page.published ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                    >
                      {href}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">{href}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground tabular-nums">
                  {monitorCount} in {page.groups?.length ?? 0} group
                  {(page.groups?.length ?? 0) === 1 ? '' : 's'}
                </TableCell>
                <TableCell>
                  {page.published ? (
                    <Badge className="bg-status-up/15 text-foreground">Published</Badge>
                  ) : (
                    <Badge variant="secondary">Draft</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {new Date(page.updatedAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
