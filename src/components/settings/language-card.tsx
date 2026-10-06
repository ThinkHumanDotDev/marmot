'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  hasMultipleLocales,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  localeNames,
  locales,
  type Locale,
} from '@/i18n/locales'
import { accountApi } from '@/lib/org-api'

interface LanguageCardProps {
  userId: string | number
  language: Locale
}

/** Remembers the choice for signed-out pages and the Payload admin (`payload-lng`) as well. */
function rememberLocale(locale: Locale) {
  const attributes = `path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; ${attributes}`
  document.cookie = `payload-lng=${encodeURIComponent(locale)}; ${attributes}`
}

/**
 * Language preference, saved on the user (`users.language`) and mirrored into the
 * `marmot-locale` cookie. Rendered only once Marmot ships more than one language.
 */
export function LanguageCard({ userId, language }: LanguageCardProps) {
  const t = useTranslations('settings.language')
  const router = useRouter()
  const [value, setValue] = React.useState<Locale>(language)
  const id = React.useId()

  if (!hasMultipleLocales()) return null

  async function choose(next: string) {
    if (!isLocale(next) || next === value) return
    const previous = value
    setValue(next)
    try {
      await accountApi.update(userId, { language: next })
      rememberLocale(next)
      toast.success(t('saved'))
      router.refresh()
    } catch (error) {
      setValue(previous)
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
        <div className="grid max-w-xs gap-2">
          <Label htmlFor={id}>{t('label')}</Label>
          <Select value={value} onValueChange={choose}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locales.map((locale) => (
                <SelectItem key={locale} value={locale} lang={locale}>
                  {localeNames[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  )
}
