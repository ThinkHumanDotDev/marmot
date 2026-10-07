'use client'

import { useTranslations } from 'next-intl'
import * as React from 'react'
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import type { NotificationFieldDescriptor } from './types'

interface ProviderFieldProps<T extends FieldValues> {
  control: Control<T>
  name: Path<T>
  field: NotificationFieldDescriptor
  /** Render the control read-only. */
  disabled?: boolean
  /** Extra one-line explanation under the field (e.g. why it is disabled). */
  note?: string | null
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === ''

/**
 * Renders one key of a provider's `configSchema` from its serialised descriptor: string → input or
 * textarea, number → numeric input, boolean → switch, enum → select.
 */
export function ProviderField<T extends FieldValues>({
  control,
  name,
  field,
  disabled = false,
  note,
}: ProviderFieldProps<T>) {
  const t = useTranslations('notifications.field')
  const id = React.useId()
  const descriptionId = `${id}-description`
  const noteId = `${id}-note`
  const errorId = `${id}-error`

  return (
    <Controller
      control={control}
      name={name}
      rules={
        field.required && field.kind !== 'boolean'
          ? {
              validate: (value: unknown) =>
                isEmpty(value) ? t('required', { label: field.label }) : true,
            }
          : undefined
      }
      render={({ field: rhf, fieldState }) => {
        const error = fieldState.error?.message
        const describedBy =
          [field.description ? descriptionId : null, note ? noteId : null, error ? errorId : null]
            .filter(Boolean)
            .join(' ') || undefined
        const common = {
          id,
          name: rhf.name,
          onBlur: rhf.onBlur,
          disabled,
          'aria-invalid': !!error,
          'aria-describedby': describedBy,
        }

        let control: React.ReactNode
        switch (field.kind) {
          case 'boolean':
            control = (
              <Switch
                {...common}
                ref={rhf.ref}
                checked={Boolean(rhf.value)}
                onCheckedChange={rhf.onChange}
              />
            )
            break
          case 'enum':
            control = (
              <Select
                value={isEmpty(rhf.value) ? '' : String(rhf.value)}
                onValueChange={rhf.onChange}
              >
                <SelectTrigger {...common} ref={rhf.ref} className="w-full">
                  <SelectValue placeholder={t('selectPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(field.values ?? []).map((value) => (
                    <SelectItem key={value} value={value}>
                      {field.options?.[value] ?? value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
            break
          case 'number':
            control = (
              <Input
                {...common}
                ref={rhf.ref}
                type="number"
                inputMode="numeric"
                placeholder={field.placeholder}
                value={isEmpty(rhf.value) ? '' : String(rhf.value)}
                onChange={(e) =>
                  rhf.onChange(e.target.value === '' ? undefined : Number(e.target.value))
                }
              />
            )
            break
          default:
            control = field.multiline ? (
              <Textarea
                {...common}
                ref={rhf.ref}
                rows={3}
                spellCheck={false}
                placeholder={field.placeholder}
                value={isEmpty(rhf.value) ? '' : String(rhf.value)}
                onChange={(e) => rhf.onChange(e.target.value)}
              />
            ) : (
              <Input
                {...common}
                ref={rhf.ref}
                type={field.secret ? 'password' : 'text'}
                autoComplete={field.secret ? 'new-password' : 'off'}
                placeholder={field.placeholder}
                value={isEmpty(rhf.value) ? '' : String(rhf.value)}
                onChange={(e) => rhf.onChange(e.target.value)}
              />
            )
        }

        const inline = field.kind === 'boolean'
        return (
          <div className={cn('grid gap-2', inline && 'gap-1')}>
            {inline ? (
              <div className="flex items-center gap-3 py-1">
                {control}
                <Label htmlFor={id} className={cn(error && 'text-destructive')}>
                  {field.label}
                </Label>
              </div>
            ) : (
              <>
                <Label htmlFor={id} className={cn(error && 'text-destructive')}>
                  {field.label}
                  {!field.required && (
                    <span className="font-normal text-muted-foreground">{t('optional')}</span>
                  )}
                </Label>
                {control}
              </>
            )}
            {field.description && (
              <p id={descriptionId} className="text-xs text-muted-foreground">
                {field.description}
              </p>
            )}
            {note && (
              <p id={noteId} className="text-xs text-muted-foreground">
                {note}
              </p>
            )}
            {error && (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )
      }}
    />
  )
}
