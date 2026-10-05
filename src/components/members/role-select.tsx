'use client'

import type { Role } from '@/access/permissions'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { ROLE_DESCRIPTIONS, ROLE_LABELS } from './role-badge'

interface RoleSelectProps {
  value: Role
  onChange: (role: Role) => void
  /** Roles the current user may hand out. Others are listed but disabled. */
  options: Role[]
  disabled?: boolean
  size?: 'sm' | 'default'
  className?: string
  'aria-label'?: string
  withDescriptions?: boolean
}

export function RoleSelect({
  value,
  onChange,
  options,
  disabled,
  size = 'default',
  className,
  withDescriptions = false,
  ...rest
}: RoleSelectProps) {
  const all: Role[] = ['owner', 'admin', 'member', 'viewer']
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)} disabled={disabled}>
      <SelectTrigger size={size} className={className} aria-label={rest['aria-label'] ?? 'Role'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {all.map((role) => (
          <SelectItem key={role} value={role} disabled={!options.includes(role)}>
            {withDescriptions ? (
              <span className="flex flex-col gap-0.5">
                <span>{ROLE_LABELS[role]}</span>
                <span className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>
              </span>
            ) : (
              ROLE_LABELS[role]
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
