'use client'

import { useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'

import { ComponentPicker, type PickerGroup } from './component-picker'

/** Component choice of a subscription (manage page), saved through the token API. */
export function ManageSubscription({
  slug,
  token,
  groups,
  initial,
}: {
  slug: string
  token: string
  groups: PickerGroup[]
  initial: string[]
}) {
  const t = useTranslations('statusPages.subscription')
  const [scoped, setScoped] = React.useState(initial.length > 0)
  const [selected, setSelected] = React.useState(initial)
  const [state, setState] = React.useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setState('saving')
    try {
      const res = await fetch(
        `/api/status-pages/${encodeURIComponent(slug)}/subscriptions/${encodeURIComponent(token)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ components: scoped ? selected : [] }),
        },
      )
      setState(res.ok ? 'saved' : 'failed')
    } catch {
      setState('failed')
    }
  }

  if (groups.length === 0) return null
  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <ComponentPicker
        legend={t('components')}
        allLabel={t('allComponents')}
        someLabel={t('someComponents')}
        groups={groups}
        scoped={scoped}
        selected={selected}
        onScopedChange={setScoped}
        onSelectedChange={setSelected}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={state === 'saving' || (scoped && selected.length === 0)}>
          {state === 'saving' ? t('saving') : t('save')}
        </Button>
        {state === 'saved' && (
          <span role="status" className="text-sm text-muted-foreground">
            {t('saved')}
          </span>
        )}
        {state === 'failed' && (
          <span role="alert" className="text-sm text-destructive">
            {t('saveFailed')}
          </span>
        )}
      </div>
    </form>
  )
}
