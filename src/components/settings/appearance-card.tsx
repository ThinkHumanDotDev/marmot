'use client'

import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import * as React from 'react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { accountApi, type ThemePreference } from '@/lib/org-api'
import { cn } from '@/lib/utils'

interface AppearanceCardProps {
  userId: string | number
  theme: ThemePreference
}

const OPTIONS: { value: ThemePreference; label: string; hint: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'System', hint: 'Follow your device setting.', icon: Monitor },
  { value: 'light', label: 'Light', hint: 'Always use the light theme.', icon: Sun },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark theme.', icon: Moon },
]

/** Theme preference: applied immediately through next-themes and saved on the user (`users.theme`). */
export function AppearanceCard({ userId, theme }: AppearanceCardProps) {
  const { setTheme } = useTheme()
  const [value, setValue] = React.useState<ThemePreference>(theme)

  async function choose(next: ThemePreference) {
    const previous = value
    setValue(next)
    setTheme(next)
    try {
      await accountApi.update(userId, { theme: next })
    } catch (error) {
      setValue(previous)
      setTheme(previous)
      toast.error(error instanceof Error ? error.message : 'Could not save your preference.')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Your theme is saved to your account and applied on every device you sign in on.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
          {OPTIONS.map((option) => {
            const selected = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => choose(option.value)}
                className={cn(
                  'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors',
                  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  selected ? 'border-foreground bg-accent/60' : 'border-border',
                )}
              >
                <option.icon className="size-5" aria-hidden />
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.hint}</span>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
