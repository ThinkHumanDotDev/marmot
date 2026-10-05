import { canManageRole, ROLES, type Role } from '@/access/permissions'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Full control, including billing and deleting the organization.',
  admin: 'Manage members, notifications and settings.',
  member: 'Create and edit monitors, status pages and maintenance.',
  viewer: 'Read-only access.',
}

/** Roles `managerRole` may hand out (never above their own). */
export const assignableRoles = (managerRole: Role | null): Role[] =>
  managerRole ? ROLES.filter((role) => canManageRole(managerRole, role)) : []

export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return (
    <Badge
      variant={role === 'owner' ? 'default' : 'secondary'}
      className={cn('capitalize', className)}
    >
      {ROLE_LABELS[role]}
    </Badge>
  )
}
