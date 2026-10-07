'use client'

import { useTranslations } from 'next-intl'
import * as React from 'react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface TimezoneSelectProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  id?: string
  /** Non-zone choices listed first, e.g. "Organization default" (`SAME_AS_SERVER`). */
  extraOptions?: { value: string; label: string }[]
}

function listTimezones(current: string): string[] {
  let zones: string[] = []
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = ['UTC']
  }
  if (!zones.includes('UTC')) zones.unshift('UTC')
  if (current && !zones.includes(current)) zones.unshift(current)
  return zones
}

const offsetLabel = (zone: string): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** IANA time zone picker backed by `Intl.supportedValuesOf`. */
export function TimezoneSelect({
  value,
  onChange,
  disabled,
  id,
  extraOptions = [],
}: TimezoneSelectProps) {
  const t = useTranslations('settings.timezone')
  const zones = React.useMemo(
    () => listTimezones(extraOptions.some((o) => o.value === value) ? '' : value),
    [value, extraOptions],
  )
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" aria-label={t('label')}>
        <SelectValue placeholder={t('placeholder')} />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {extraOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        {zones.map((zone) => (
          <SelectItem key={zone} value={zone}>
            <span className="flex items-center gap-2">
              <span>{zone.replaceAll('_', ' ')}</span>
              <span className="text-xs text-muted-foreground">{offsetLabel(zone)}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
