'use client'

import { RotateCcw } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'

import type { Permission, Role } from '@/access/permissions'
import { RoleSelect } from '@/components/members/role-select'
import { ROLE_LABELS } from '@/components/members/role-badge'
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

interface PermissionsTableProps {
  orgId: string | number
  initial: PermissionsResponse
}

const RESOURCE_LABELS: Record<string, string> = {
  organization: 'Organization',
  member: 'Members',
  monitor: 'Monitors',
  notification: 'Notifications',
  'status-page': 'Status pages',
  maintenance: 'Maintenance',
  'api-key': 'API keys',
  'audit-log': 'Audit log',
  sso: 'Single sign-on',
}

const ACTION_LABELS: Record<string, string> = {
  read: 'View',
  create: 'Create',
  update: 'Edit',
  delete: 'Delete',
  invite: 'Invite',
  remove: 'Remove',
  'update-role': 'Change roles',
  manage: 'Manage',
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
      toast.success('Permissions updated')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save permissions.')
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
        <CardTitle>Permissions</CardTitle>
        <CardDescription>
          {canEdit
            ? 'The minimum role needed for each action. Roles above the minimum are always allowed.'
            : 'Only owners can change permissions. Roles above the minimum are always allowed.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead className="w-44">Minimum role</TableHead>
                <TableHead className="w-28">Default</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(groups).map(([resource, list]) => (
                <React.Fragment key={resource}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={3} className="py-2 text-xs font-semibold uppercase">
                      {RESOURCE_LABELS[resource] ?? resource}
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
                            <span>{ACTION_LABELS[action] ?? action}</span>
                            <code className="text-xs text-muted-foreground">{permission}</code>
                            {changed && <Badge variant="secondary">Custom</Badge>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <RoleSelect
                            value={draft[permission]}
                            onChange={(role) => setDraft((d) => ({ ...d, [permission]: role }))}
                            options={ALL_ROLES}
                            disabled={!canEdit || locked || pending}
                            size="sm"
                            aria-label={`Minimum role for ${permission}`}
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {ROLE_LABELS[saved.defaults[permission]]}
                          {locked && <span className="ml-1 text-xs">(fixed)</span>}
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
            <RotateCcw aria-hidden /> Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setDraft(saved.effective)}
              disabled={pending || !dirty}
            >
              Discard
            </Button>
            <Button onClick={saveDraft} disabled={pending || !dirty}>
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  )
}
