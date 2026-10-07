'use client'

import { RotateCcw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import type { Permission, Role } from '@/access/permissions'
import { RoleSelect } from '@/components/members/role-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { permissionsApi, type PermissionsResponse } from '@/lib/org-api'

import { actionKey, resourceKey } from './permission-labels'

interface PermissionsTableProps {
  orgId: string | number
  initial: PermissionsResponse
}

const ALL_ROLES: Role[] = ['owner', 'admin', 'member', 'viewer']

const split = (permission: Permission) => {
  const [resource, action] = permission.split(':')
  return { resource, action }
}

/**
 * Who can do what in this organization (kan.bn-style permission overrides): one row per
 * `resource:action` with the minimum role. Owners edit, everyone else reads. Saved as a diff from
 * the defaults through `PUT /api/orgs/:orgId/permissions`.
 */
export function PermissionsTable({ orgId, initial }: PermissionsTableProps) {
  const t = useTranslations('settings.permissions')
  const tr = useTranslations('members.roles')
  const resourceLabel = (resource: string) => {
    const key = resourceKey(resource)
    return key ? t(`resources.${key}`) : resource
  }
  const actionLabel = (action: string) => {
    const key = actionKey(action)
    return key ? t(`actions.${key}`) : action
  }
  const [saved, setSaved] = React.useState(initial)
  const [draft, setDraft] = React.useState<Record<Permission, Role>>(initial.effective)
  const [pending, setPending] = React.useState(false)
  const canEdit = saved.canEdit

  const permissions = Object.keys(saved.defaults) as Permission[]
  const groups = permissions.reduce<Record<string, Permission[]>>((acc, permission) => {
    const { resource } = split(permission)
    ;(acc[resource] ??= []).push(permission)
    return acc
  }, {})

  const dirty = permissions.some((p) => draft[p] !== saved.effective[p])
  const customised = permissions.some((p) => saved.effective[p] !== saved.defaults[p])

  async function save(overrides: Partial<Record<Permission, Role>>) {
    setPending(true)
    try {
      const result = await permissionsApi.update(orgId, overrides)
      setSaved(result)
      setDraft(result.effective)
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setPending(false)
    }
  }

  function saveDraft() {
    const overrides: Partial<Record<Permission, Role>> = {}
    for (const permission of permissions) {
      if (draft[permission] !== saved.defaults[permission])
        overrides[permission] = draft[permission]
    }
    void save(overrides)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{canEdit ? t('description') : t('readOnly')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.action')}</TableHead>
                <TableHead className="w-44">{t('columns.minimumRole')}</TableHead>
                <TableHead className="w-28">{t('columns.default')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(groups).map(([resource, list]) => (
                <React.Fragment key={resource}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={3} className="py-2 text-xs font-semibold uppercase">
                      {resourceLabel(resource)}
                    </TableCell>
                  </TableRow>
                  {list.map((permission) => {
                    const { action } = split(permission)
                    const locked = saved.locked.includes(permission)
                    const changed = draft[permission] !== saved.defaults[permission]
                    return (
                      <TableRow key={permission}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span>{actionLabel(action)}</span>
                            <code className="text-xs text-muted-foreground">{permission}</code>
                            {changed && <Badge variant="secondary">{t('custom')}</Badge>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <RoleSelect
                            value={draft[permission]}
                            onChange={(role) => setDraft((d) => ({ ...d, [permission]: role }))}
                            options={ALL_ROLES}
                            disabled={!canEdit || locked || pending}
                            size="sm"
                            aria-label={t('minimumRoleFor', { permission })}
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {tr(`${saved.defaults[permission]}.label`)}
                          {locked && <span className="ml-1 text-xs">{t('fixed')}</span>}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      {canEdit && (
        <CardFooter className="justify-between gap-2 border-t pt-6">
          <Button
            variant="ghost"
            onClick={() => save({})}
            disabled={pending || (!customised && !dirty)}
          >
            <RotateCcw aria-hidden /> {t('reset')}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setDraft(saved.effective)}
              disabled={pending || !dirty}
            >
              {t('discard')}
            </Button>
            <Button onClick={saveDraft} disabled={pending || !dirty}>
              {pending ? t('saving') : t('save')}
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  )
}
