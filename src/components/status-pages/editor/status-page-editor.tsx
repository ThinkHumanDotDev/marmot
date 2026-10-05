'use client'

import { ArrowLeft, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import * as React from 'react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Incident, StatusPage } from '@/payload-types'

import { publicStatusPagePath, statusPagesApi, type MonitorOption, type OrgId } from '../api'
import { DomainsPanel } from './domains-panel'
import { GroupsEditor } from './groups-editor'
import { IncidentsPanel } from './incidents-panel'
import { SettingsForm } from './settings-form'

export interface EditorProps {
  orgId: OrgId
  orgSlug: string
  initialPage: StatusPage
  initialIncidents: Incident[]
  monitors: MonitorOption[]
  canEdit: boolean
  canDelete: boolean
}

export function StatusPageEditor({
  orgId,
  orgSlug,
  initialPage,
  initialIncidents,
  monitors,
  canEdit,
  canDelete,
}: EditorProps) {
  const [page, setPage] = React.useState(initialPage)
  const [publishing, setPublishing] = React.useState(false)
  const publicHref = publicStatusPagePath(page.slug)

  async function togglePublished(next: boolean) {
    setPublishing(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, { published: next })
      setPage(doc)
      toast.success(next ? 'Status page published' : 'Status page unpublished')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <Link
            href={`/${orgSlug}/status-pages`}
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ArrowLeft className="size-3" aria-hidden /> Status pages
          </Link>
        }
        title={
          <span className="inline-flex items-center gap-3">
            {page.title}
            {page.published ? (
              <Badge className="bg-status-up/15 text-foreground">Published</Badge>
            ) : (
              <Badge variant="secondary">Draft</Badge>
            )}
          </span>
        }
        description={<span className="font-mono text-xs">{publicHref}</span>}
        actions={
          <>
            <div className="flex items-center gap-2 pr-2">
              <Switch
                id="sp-published"
                checked={Boolean(page.published)}
                disabled={!canEdit || publishing}
                onCheckedChange={togglePublished}
              />
              <Label htmlFor="sp-published" className="text-sm">
                Published
              </Label>
            </div>
            <Button asChild variant="outline">
              <a href={publicHref} target="_blank" rel="noopener noreferrer">
                {page.published ? 'View page' : 'Preview'} <ExternalLink />
              </a>
            </Button>
          </>
        }
      />
      <section className="p-6 md:p-8">
        {!page.published && (
          <p className="mb-6 rounded-lg border border-dashed px-4 py-2 text-xs text-muted-foreground">
            Visitors get a 404 until the page is published. Signed-in members can preview it any
            time.
          </p>
        )}
        <Tabs defaultValue="settings">
          <TabsList>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="groups">Groups &amp; monitors</TabsTrigger>
            <TabsTrigger value="incidents">Incidents</TabsTrigger>
            <TabsTrigger value="domains">Domains</TabsTrigger>
          </TabsList>
          <TabsContent value="settings" className="pt-6">
            <SettingsForm
              orgId={orgId}
              orgSlug={orgSlug}
              page={page}
              onSaved={setPage}
              canEdit={canEdit}
              canDelete={canDelete}
            />
          </TabsContent>
          <TabsContent value="groups" className="pt-6">
            <GroupsEditor
              orgId={orgId}
              page={page}
              monitors={monitors}
              onSaved={setPage}
              canEdit={canEdit}
            />
          </TabsContent>
          <TabsContent value="incidents" className="pt-6">
            <IncidentsPanel
              orgId={orgId}
              pageId={page.id}
              initialIncidents={initialIncidents}
              canEdit={canEdit}
            />
          </TabsContent>
          <TabsContent value="domains" className="pt-6">
            <DomainsPanel orgId={orgId} page={page} onSaved={setPage} canEdit={canEdit} />
          </TabsContent>
        </Tabs>
      </section>
    </>
  )
}
