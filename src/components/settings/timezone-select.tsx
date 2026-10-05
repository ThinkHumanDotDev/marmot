'use client'

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
export function TimezoneSelect({ value, onChange, disabled, id }: TimezoneSelectProps) {
  const zones = React.useMemo(() => listTimezones(value), [value])
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" aria-label="Time zone">
        <SelectValue placeholder="Select a time zone" />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
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
