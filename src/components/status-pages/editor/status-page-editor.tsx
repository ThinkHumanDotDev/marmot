'use client'

import { ArrowLeft, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { track } from '@/lib/analytics'
import type { Incident, StatusPage } from '@/payload-types'

import { publicStatusPagePath, statusPagesApi, type MonitorOption, type OrgId } from '../api'
import { AccessPanel } from './access-panel'
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
  /** Organization time zone the incident timestamps render in. */
  timeZone: string
}

export function StatusPageEditor({
  orgId,
  orgSlug,
  initialPage,
  initialIncidents,
  monitors,
  canEdit,
  canDelete,
  timeZone,
}: EditorProps) {
  const t = useTranslations('statusPages.editorPage')
  const ta = useTranslations('statusPages.access.editor')
  const [page, setPage] = React.useState(initialPage)
  const [publishing, setPublishing] = React.useState(false)
  const publicHref = publicStatusPagePath(page.slug)

  async function togglePublished(next: boolean) {
    setPublishing(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, { published: next })
      setPage(doc)
      if (next) track('status_page_published')
      toast.success(next ? t('publishedToast') : t('unpublishedToast'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('updateFailed'))
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
            <ArrowLeft className="size-3" aria-hidden /> {t('back')}
          </Link>
        }
        title={
          <span className="inline-flex max-w-full items-center gap-3">
            <span className="truncate">{page.title}</span>
            {page.published ? (
              <Badge className="bg-status-up/15 text-foreground">{t('published')}</Badge>
            ) : (
              <Badge variant="secondary">{t('draft')}</Badge>
            )}
          </span>
        }
        description={<span className="font-mono text-xs break-all">{publicHref}</span>}
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
                {t('publishedLabel')}
              </Label>
            </div>
            <Button asChild variant="outline">
              <a href={publicHref} target="_blank" rel="noopener noreferrer">
                {page.published ? t('viewPage') : t('preview')} <ExternalLink aria-hidden />
                <span className="sr-only">{t('opensInNewTab')}</span>
              </a>
            </Button>
          </>
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
        {!page.published && (
          <p className="mb-6 rounded-lg border border-dashed px-4 py-2 text-xs text-muted-foreground">
            {t('draftNotice')}
          </p>
        )}
        <Tabs defaultValue="settings">
          <TabsList className="no-scrollbar max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="settings">{t('tabs.settings')}</TabsTrigger>
            <TabsTrigger value="groups">{t('tabs.groups')}</TabsTrigger>
            <TabsTrigger value="incidents">{t('tabs.incidents')}</TabsTrigger>
            <TabsTrigger value="domains">{t('tabs.domains')}</TabsTrigger>
            <TabsTrigger value="access">{ta('tab')}</TabsTrigger>
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
              timeZone={timeZone}
              canEdit={canEdit}
              page={page}
              monitors={monitors}
            />
          </TabsContent>
          <TabsContent value="domains" className="pt-6">
            <DomainsPanel orgId={orgId} page={page} onSaved={setPage} canEdit={canEdit} />
          </TabsContent>
          <TabsContent value="access" className="pt-6">
            <AccessPanel orgId={orgId} page={page} onSaved={setPage} canEdit={canEdit} />
          </TabsContent>
        </Tabs>
      </section>
    </>
  )
}
