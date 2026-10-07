'use client'

import { Check, Copy } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import {
  BADGE_EMBED_STYLES,
  DEFAULT_BADGE_EMBED_OPTIONS,
  statusPageBadgeSnippets,
  statusPageBadgeUrl,
  statusPageBaseUrl,
  type BadgeEmbedOptions,
} from '@/lib/status-page-badge'
import type { StatusPage } from '@/payload-types'

const MAIN_HOST = '__main__'
const noopSubscribe = () => () => {}

/** Origin of the app in the browser; empty during server rendering. */
function useOrigin(): string {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => '',
  )
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const t = useTranslations('statusPages.share')
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
      <Textarea
        id={id}
        readOnly
        rows={2}
        spellCheck={false}
        className="font-mono text-xs break-all"
        value={value}
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  )
}

/** "Share" tab: the overall status badge (issue #110) with Markdown and HTML embed snippets. */
export function SharePanel({ page }: { page: StatusPage }) {
  const t = useTranslations('statusPages.share')
  const origin = useOrigin()
  const [options, setOptions] = React.useState<BadgeEmbedOptions>(DEFAULT_BADGE_EMBED_OPTIONS)
  const [host, setHost] = React.useState(MAIN_HOST)
  const domains = (page.domains ?? []).map((d) => d.hostname)
  const customHost = host !== MAIN_HOST && domains.includes(host) ? host : null

  const set = <K extends keyof BadgeEmbedOptions>(key: K, value: BadgeEmbedOptions[K]) =>
    setOptions((current) => ({ ...current, [key]: value }))

  const pageUrl = statusPageBaseUrl(origin, page.slug, customHost)
  const badgeUrl = statusPageBadgeUrl(pageUrl, options)
  // The preview always loads from Marmot's own host: a custom domain may not resolve yet.
  const previewUrl = statusPageBadgeUrl(statusPageBaseUrl(origin, page.slug), options)
  const alt = t('altText', { title: page.title })
  const snippets = statusPageBadgeSnippets({ pageUrl, badgeUrl, alt })
  const isPill = options.style === 'pill'

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {!page.published && (
          <p className="rounded-lg border border-dashed px-4 py-2 text-xs text-muted-foreground">
            {t('draftNotice')}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {domains.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="badge-host">{t('address')}</Label>
              <Select value={customHost ?? MAIN_HOST} onValueChange={setHost}>
                <SelectTrigger id="badge-host">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MAIN_HOST}>{t('mainAddress')}</SelectItem>
                  {domains.map((domain) => (
                    <SelectItem key={domain} value={domain}>
                      {domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="badge-style">{t('style')}</Label>
            <Select
              value={options.style}
              onValueChange={(v) => set('style', v as BadgeEmbedOptions['style'])}
            >
              <SelectTrigger id="badge-style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BADGE_EMBED_STYLES.map((style) => (
                  <SelectItem key={style} value={style}>
                    {t(`styles.${style}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isPill && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="badge-theme">{t('theme')}</Label>
                <Select
                  value={options.theme}
                  onValueChange={(v) => set('theme', v as BadgeEmbedOptions['theme'])}
                >
                  <SelectTrigger id="badge-theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">{t('themes.light')}</SelectItem>
                    <SelectItem value="dark">{t('themes.dark')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="badge-size">{t('size')}</Label>
                <Select
                  value={options.size}
                  onValueChange={(v) => set('size', v as BadgeEmbedOptions['size'])}
                >
                  <SelectTrigger id="badge-size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sm">{t('sizes.sm')}</SelectItem>
                    <SelectItem value="md">{t('sizes.md')}</SelectItem>
                    <SelectItem value="lg">{t('sizes.lg')}</SelectItem>
                    <SelectItem value="xl">{t('sizes.xl')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="badge-variant">{t('variant')}</Label>
                <Select
                  value={options.variant}
                  onValueChange={(v) => set('variant', v as BadgeEmbedOptions['variant'])}
                >
                  <SelectTrigger id="badge-variant">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('variants.default')}</SelectItem>
                    <SelectItem value="outline">{t('variants.outline')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label htmlFor="badge-label">{t('label')}</Label>
            <Input
              id="badge-label"
              maxLength={64}
              placeholder={isPill ? t('labelPlaceholderPill') : t('labelPlaceholderShields')}
              value={options.label}
              onChange={(e) => set('label', e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-2">
          <span className="text-sm font-medium">{t('preview')}</span>
          <div
            className={
              options.theme === 'dark' && isPill
                ? 'flex min-h-16 items-center rounded-lg border bg-zinc-950 px-4 py-3'
                : 'flex min-h-16 items-center rounded-lg border bg-white px-4 py-3'
            }
          >
            {origin && (
              // eslint-disable-next-line @next/next/no-img-element -- live SVG from our own endpoint
              <img src={previewUrl} alt={alt} data-testid="status-page-badge-preview" />
            )}
          </div>
        </div>

        <CopyField id="badge-markdown" label={t('markdown')} value={snippets.markdown} />
        <CopyField id="badge-html" label={t('html')} value={snippets.html} />
        <CopyField id="badge-url" label={t('imageUrl')} value={badgeUrl} />
      </CardContent>
    </Card>
  )
}
