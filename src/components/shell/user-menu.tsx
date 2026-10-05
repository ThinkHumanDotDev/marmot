'use client'

import { LogOut, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import * as React from 'react'
import { toast } from 'sonner'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { authApi } from '@/lib/api'
import { cn, initials } from '@/lib/utils'

import type { ShellUser } from './types'

interface UserMenuProps {
  user: ShellUser
  collapsed?: boolean
}

export function UserMenu({ user, collapsed = false }: UserMenuProps) {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const [signingOut, setSigningOut] = React.useState(false)
  const displayName = user.name?.trim() || user.email

  async function signOut() {
    setSigningOut(true)
    try {
      await authApi.logout()
    } catch {
      // The cookie may already be gone; fall through to the login page either way.
    }
    router.replace('/login')
    router.refresh()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${displayName}`}
        className={cn(
          'flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none transition-colors',
          'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent',
          collapsed && 'justify-center px-0',
        )}
      >
        <Avatar className="size-7 rounded-md">
          <AvatarFallback className="rounded-md bg-primary/15 text-[11px] font-semibold text-primary">
            {initials(displayName)}
          </AvatarFallback>
        </Avatar>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{displayName}</span>
            {user.name && (
              <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
            )}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate font-medium">{displayName}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" aria-hidden /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" aria-hidden /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4" aria-hidden /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {user.superadmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <ShieldCheck className="size-4" aria-hidden /> Admin panel
              </Link>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault()
            toast.promise(signOut(), { loading: 'Signing out…', success: 'Signed out' })
          }}
        >
          <LogOut className="size-4" aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
