'use client'

import { Check, Link2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'

/**
 * Copies the permalink of the current page (the address the visitor sees, so custom domains keep
 * their host) and confirms it in place; the confirmation is announced to screen readers.
 */
export function CopyLinkButton() {
  const t = useTranslations('statusPages.events')
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle')

  React.useEffect(() => {
    if (state === 'idle') return
    const id = window.setTimeout(() => setState('idle'), 2000)
    return () => window.clearTimeout(id)
  }, [state])

  const copy = async () => {
    const url = `${window.location.origin}${window.location.pathname}`
    try {
      await navigator.clipboard.writeText(url)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} data-copy-link>
      {state === 'copied' ? (
        <Check className="size-4" aria-hidden />
      ) : (
        <Link2 className="size-4" aria-hidden />
      )}
      <span aria-live="polite">
        {state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : t('copyLink')}
      </span>
    </Button>
  )
}
