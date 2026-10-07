import { useTranslations } from 'next-intl'

import { canManageRole, ROLES, type Role } from '@/access/permissions'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Roles `managerRole` may hand out (never above their own). */
export const assignableRoles = (managerRole: Role | null): Role[] =>
  managerRole ? ROLES.filter((role) => canManageRole(managerRole, role)) : []

export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  const t = useTranslations('members.roles')
  return (
    <Badge
      variant={role === 'owner' ? 'default' : 'secondary'}
      className={cn('capitalize', className)}
    >
      {t(`${role}.label`)}
    </Badge>
  )
}
