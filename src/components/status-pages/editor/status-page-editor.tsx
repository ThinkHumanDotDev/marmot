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
import { componentDisplayName } from '@/lib/status-page-components'
import type { TemplateRow } from '@/lib/templates'
import type { Incident, StatusPage } from '@/payload-types'

import {
  publicStatusPagePath,
  relationId,
  statusPagesApi,
  type MonitorOption,
  type OrgId,
} from '../api'
import { AccessPanel } from './access-panel'
import { DomainsPanel } from './domains-panel'
import { GroupsEditor } from './groups-editor'
import { IncidentsPanel, type IncidentComponentOption } from './incidents-panel'
import { NotificationsPanel } from './notifications-panel'
import { SettingsForm } from './settings-form'
import { SharePanel } from './share-panel'
import { SubscribersPanel, type SmsChannelOption } from './subscribers-panel'
import { ThemeEditor } from './theme-editor'

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
  /** Name of the organization (`{{ organization }}` in templates). */
  orgName: string
  /** Incident templates of the organization (all pages, all kinds). */
  templates: TemplateRow[]
  /** `subscriber:read`, `subscriber:manage` and `subscriber:send` in the organization. */
  canReadSubscribers: boolean
  canManageSubscribers: boolean
  canSendNotifications: boolean
  /** Twilio channels of the organization (SMS sender of subscriptions). */
  smsChannels: SmsChannelOption[]
  /** Instance setting `trustProxy` (the IP allow-list needs client addresses). */
  trustProxy: boolean
  /** The organization's plan serves custom domains (always without billing, #161). */
  customDomains?: boolean
}

/** The page's components (group rows, by row id) in display order: what an incident can affect. */
function pageComponents(page: StatusPage, monitors: MonitorOption[]): IncidentComponentOption[] {
  const byId = new Map(monitors.map((m) => [String(m.id), m]))
  return (page.groups ?? []).flatMap((group) =>
    (group.monitors ?? []).flatMap((row) => {
      if (!row.id) return []
      const monitor =
        row.type === 'static' || row.monitor == null ? null : byId.get(relationId(row.monitor))
      const name = componentDisplayName(row.name, monitor) || `${group.name} #${row.id.slice(-4)}`
      return [{ id: row.id, name }]
    }),
  )
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
  orgName,
  templates,
  canReadSubscribers,
  canManageSubscribers,
  canSendNotifications,
  smsChannels,
  trustProxy,
  customDomains = true,
}: EditorProps) {
  const t = useTranslations('statusPages.editorPage')
  const ta = useTranslations('statusPages.access.editor')
  const [page, setPage] = React.useState(initialPage)
  const [publishing, setPublishing] = React.useState(false)
  const publicHref = publicStatusPagePath(page.slug)
  const incidentComponents = React.useMemo(() => pageComponents(page, monitors), [page, monitors])
  const templateContext = React.useMemo(
    () => ({
      templates: templates.filter(
        (template) => template.statusPage === null || template.statusPage === String(page.id),
      ),
      organization: orgName,
      page: page.title,
    }),
    [templates, orgName, page.id, page.title],
  )

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
            <TabsTrigger value="theme">{t('tabs.theme')}</TabsTrigger>
            <TabsTrigger value="groups">{t('tabs.groups')}</TabsTrigger>
            <TabsTrigger value="incidents">{t('tabs.incidents')}</TabsTrigger>
            <TabsTrigger value="subscribers">{t('tabs.subscribers')}</TabsTrigger>
            {canReadSubscribers && (
              <TabsTrigger value="notifications">{t('tabs.notifications')}</TabsTrigger>
            )}
            <TabsTrigger value="domains">{t('tabs.domains')}</TabsTrigger>
            <TabsTrigger value="access">{ta('tab')}</TabsTrigger>
            <TabsTrigger value="share">{t('tabs.share')}</TabsTrigger>
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
          <TabsContent value="theme" className="pt-6">
            <ThemeEditor orgId={orgId} page={page} onSaved={setPage} canEdit={canEdit} />
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
              components={incidentComponents}
              templateContext={templateContext}
              timeZone={timeZone}
              canEdit={canEdit}
            />
          </TabsContent>
          <TabsContent value="subscribers" className="pt-6">
            <SubscribersPanel
              orgId={orgId}
              page={page}
              onSaved={setPage}
              canEdit={canEdit}
              canRead={canReadSubscribers}
              canManage={canManageSubscribers}
              smsChannels={smsChannels}
              components={incidentComponents}
            />
          </TabsContent>
          {canReadSubscribers && (
            <TabsContent value="notifications" className="pt-6">
              <NotificationsPanel orgId={orgId} pageId={page.id} canSend={canSendNotifications} />
            </TabsContent>
          )}
          <TabsContent value="domains" className="pt-6">
            <DomainsPanel
              orgId={orgId}
              page={page}
              onSaved={setPage}
              canEdit={canEdit}
              customDomains={customDomains}
            />
          </TabsContent>
          <TabsContent value="access" className="pt-6">
            <AccessPanel
              orgId={orgId}
              page={page}
              onSaved={setPage}
              canEdit={canEdit}
              trustProxy={trustProxy}
              timeZone={timeZone}
            />
          </TabsContent>
          <TabsContent value="share" className="pt-6">
            <SharePanel page={page} />
          </TabsContent>
        </Tabs>
      </section>
    </>
  )
}
