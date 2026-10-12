'use client'

import { Eye, Pencil, Plus, Trash2, UsersRound } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusPageView } from '@/components/status-pages/public/status-page-view'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { MAX_AUDIENCE_NAME_LENGTH } from '@/lib/status-page-audiences'
import type { StatusPage, StatusPageAudience } from '@/payload-types'
import type { PublicStatusPageData } from '@/server/status-pages/public'

import { statusPagesApi, type AudienceDraft, type OrgId } from '../api'
import type { IncidentComponentOption } from './incidents-panel'

const lines = (text: string) =>
  text
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean)

interface ComponentGroup {
  name: string
  components: IncidentComponentOption[]
}

/** The page's components grouped as on the page (row ids), named like the incident editor does. */
function componentGroups(page: StatusPage, names: ReadonlyMap<string, string>): ComponentGroup[] {
  return (page.groups ?? [])
    .map((group) => ({
      name: group.name,
      components: (group.monitors ?? []).flatMap((row) =>
        row.id ? [{ id: row.id, name: names.get(row.id) ?? group.name }] : [],
      ),
    }))
    .filter((group) => group.components.length > 0)
}

function AudienceForm({
  groups,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  groups: ComponentGroup[]
  initial: StatusPageAudience | null
  busy: boolean
  onCancel: () => void
  onSubmit: (draft: AudienceDraft) => void
}) {
  const t = useTranslations('statusPages.audiences')
  const id = React.useId()
  const [name, setName] = React.useState(initial?.name ?? '')
  const [components, setComponents] = React.useState<string[]>(initial?.components ?? [])
  const [emails, setEmails] = React.useState((initial?.emails ?? []).join('\n'))
  const [domains, setDomains] = React.useState((initial?.emailDomains ?? []).join('\n'))

  return (
    <form
      className="flex flex-col gap-4 rounded-xl border p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({
          name: name.trim(),
          components,
          emails: lines(emails),
          emailDomains: lines(domains),
        })
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>{t('name')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          required
          maxLength={MAX_AUDIENCE_NAME_LENGTH}
          placeholder={t('namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('components')}</legend>
        {groups.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('noComponents')}</p>
        )}
        {groups.map((group) => (
          <div key={group.name} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{group.name}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {group.components.map((component) => (
                <label key={component.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={components.includes(component.id)}
                    onChange={(e) =>
                      setComponents((list) =>
                        e.target.checked
                          ? [...list, component.id]
                          : list.filter((c) => c !== component.id),
                      )
                    }
                  />
                  {component.name}
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-emails`}>{t('emails')}</Label>
          <Textarea
            id={`${id}-emails`}
            rows={4}
            spellCheck={false}
            value={emails}
            placeholder="ops@acme.com"
            aria-describedby={`${id}-emails-hint`}
            onChange={(e) => setEmails(e.target.value)}
          />
          <p id={`${id}-emails-hint`} className="text-xs text-muted-foreground">
            {t('emailsHint')}
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-domains`}>{t('domains')}</Label>
          <Textarea
            id={`${id}-domains`}
            rows={4}
            spellCheck={false}
            value={domains}
            placeholder="acme.com"
            aria-describedby={`${id}-domains-hint`}
            onChange={(e) => setDomains(e.target.value)}
          />
          <p id={`${id}-domains-hint`} className="text-xs text-muted-foreground">
            {t('domainsHint')}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  )
}

/**
 * Builder tab "Audiences" (#151): who among the signed-in visitors of an audience page sees which
 * components, and a "view as" preview of the page for each audience.
 */
export function AudiencesPanel({
  orgId,
  page,
  components,
  canEdit,
}: {
  orgId: OrgId
  page: StatusPage
  components: IncidentComponentOption[]
  canEdit: boolean
}) {
  const t = useTranslations('statusPages.audiences')
  const [audiences, setAudiences] = React.useState<StatusPageAudience[] | null>(null)
  const [editing, setEditing] = React.useState<StatusPageAudience | 'new' | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [deleting, setDeleting] = React.useState<StatusPageAudience | null>(null)
  const [previewId, setPreviewId] = React.useState<string>('')
  const [preview, setPreview] = React.useState<PublicStatusPageData | null>(null)

  const names = React.useMemo(() => new Map(components.map((c) => [c.id, c.name])), [components])
  const groups = React.useMemo(() => componentGroups(page, names), [page, names])

  React.useEffect(() => {
    let cancelled = false
    statusPagesApi.audiences
      .list(orgId, page.id)
      .then(({ docs }) => {
        if (!cancelled) setAudiences(docs)
      })
      .catch(() => {
        if (!cancelled) {
          setAudiences([])
          toast.error(t('loadFailed'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [orgId, page.id, t])

  const loadPreview = React.useCallback(
    async (audienceId: string) => {
      setPreviewId(audienceId)
      setPreview(null)
      if (!audienceId) return
      try {
        setPreview(await statusPagesApi.audiences.preview(orgId, page.id, audienceId))
      } catch {
        toast.error(t('preview.loadFailed'))
      }
    },
    [orgId, page.id, t],
  )

  async function save(draft: AudienceDraft) {
    setBusy(true)
    try {
      const { doc } =
        editing === 'new' || editing === null
          ? await statusPagesApi.audiences.create(orgId, page.id, draft)
          : await statusPagesApi.audiences.update(orgId, page.id, editing.id, draft)
      setAudiences((list) =>
        editing === 'new'
          ? [...(list ?? []), doc]
          : (list ?? []).map((a) => (String(a.id) === String(doc.id) ? doc : a)),
      )
      setEditing(null)
      toast.success(t('saved'))
      if (previewId === String(doc.id)) void loadPreview(previewId)
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(audience: StatusPageAudience) {
    try {
      await statusPagesApi.audiences.remove(orgId, page.id, audience.id)
      setAudiences((list) => (list ?? []).filter((a) => String(a.id) !== String(audience.id)))
      if (previewId === String(audience.id)) void loadPreview('')
      toast.success(t('deleted'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h2 className="text-base font-medium">{t('title')}</h2>
            <p className="text-sm text-muted-foreground">{t('description')}</p>
          </div>
          {canEdit && editing === null && (
            <Button type="button" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> {t('add')}
            </Button>
          )}
        </div>
        {page.access !== 'audience' && (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t('modeOff')}
          </p>
        )}

        {editing !== null && (
          <AudienceForm
            key={editing === 'new' ? 'new' : String(editing.id)}
            groups={groups}
            initial={editing === 'new' ? null : editing}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={save}
          />
        )}

        {audiences !== null && audiences.length === 0 && editing === null && (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        )}

        <ul className="flex flex-col gap-2" data-testid="audience-list">
          {(audiences ?? []).map((audience) => (
            <li
              key={String(audience.id)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <UsersRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{audience.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t('summary', {
                      components: audience.components?.length ?? 0,
                      members:
                        (audience.emails?.length ?? 0) + (audience.emailDomains?.length ?? 0),
                    })}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadPreview(String(audience.id))}
                >
                  <Eye aria-hidden /> {t('preview.title')}
                </Button>
                {canEdit && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(audience)}
                    >
                      <Pencil aria-hidden /> {t('edit')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleting(audience)}
                    >
                      <Trash2 aria-hidden /> {t('delete')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {(audiences?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-4" aria-labelledby="sp-audience-preview">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="sp-audience-preview" className="text-base font-medium">
                {t('preview.title')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('preview.description')}</p>
            </div>
            <Select value={previewId} onValueChange={(value) => void loadPreview(value)}>
              <SelectTrigger className="w-64" aria-label={t('preview.choose')}>
                <SelectValue placeholder={t('preview.choose')} />
              </SelectTrigger>
              <SelectContent>
                {(audiences ?? []).map((audience) => (
                  <SelectItem key={String(audience.id)} value={String(audience.id)}>
                    {audience.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {preview && (
            <div
              className="overflow-hidden rounded-xl border bg-background"
              data-testid="audience-preview"
            >
              <StatusPageView key={previewId} slug={page.slug} initial={preview} />
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('deleteTitle', { name: deleting?.name ?? '' })}
        description={t('deleteDescription')}
        confirmLabel={t('delete')}
        destructive
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </div>
  )
}
