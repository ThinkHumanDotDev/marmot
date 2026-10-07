'use client'

import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
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

const OPTIONS: { value: ThemePreference; icon: LucideIcon }[] = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
]

/** Theme preference: applied immediately through next-themes and saved on the user (`users.theme`). */
export function AppearanceCard({ userId, theme }: AppearanceCardProps) {
  const t = useTranslations('settings.account.appearance')
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
      toast.error(error instanceof Error ? error.message : t('failed'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div role="radiogroup" aria-label={t('label')} className="grid gap-3 sm:grid-cols-3">
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
                <span className="text-sm font-medium">{t(`options.${option.value}.label`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`options.${option.value}.hint`)}
                </span>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
