'use client'

import { FlaskConical, Loader2, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { useFieldArray, type Control } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { BROWSER_ARTIFACT_MODES, BROWSER_SCRIPT_MAX_VARIABLES } from '@/lib/browser-script'
import type { MonitorFormInput, MonitorFormValues } from '@/lib/validation/monitor'

type FormControlType = Control<MonitorFormInput, unknown, MonitorFormValues>

const INDENT = '  '

/**
 * Script editor: a monospace text area where Tab indents (and Shift+Tab outdents) the selected
 * lines instead of leaving the field; Escape then Tab still moves focus on.
 */
function ScriptEditor({
  value,
  onChange,
  onBlur,
  label,
  ...props
}: Omit<React.ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
  label: string
}) {
  const tabMode = React.useRef(true)
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      tabMode.current = false
      return
    }
    if (event.key !== 'Tab' || !tabMode.current) return
    event.preventDefault()
    const el = event.currentTarget
    const { selectionStart: start, selectionEnd: end } = el
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const block = value.slice(lineStart, end)
    const lines = block.split('\n')
    const changed = event.shiftKey
      ? lines.map((line) => (line.startsWith(INDENT) ? line.slice(INDENT.length) : line))
      : start === end
        ? null
        : lines.map((line) => INDENT + line)
    if (changed === null) {
      // No selection: insert the indent at the caret.
      onChange(value.slice(0, start) + INDENT + value.slice(end))
      requestAnimationFrame(() =>
        el.setSelectionRange(start + INDENT.length, start + INDENT.length),
      )
      return
    }
    const replaced = changed.join('\n')
    onChange(value.slice(0, lineStart) + replaced + value.slice(end))
    requestAnimationFrame(() => el.setSelectionRange(lineStart, lineStart + replaced.length))
  }
  return (
    <Textarea
      {...props}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => {
        tabMode.current = true
        onBlur?.(event)
      }}
      onKeyDown={onKeyDown}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      wrap="off"
      className="min-h-72 font-mono text-xs leading-5 [tab-size:2]"
    />
  )
}

/** Name / value rows of `browserVariables` or `browserSecrets`. */
function VariableList({
  control,
  name,
  label,
  description,
  secret,
}: {
  control: FormControlType
  name: 'browserVariables' | 'browserSecrets'
  label: string
  description: string
  secret?: boolean
}) {
  const t = useTranslations('monitors.form.browserScript')
  const { fields, append, remove } = useFieldArray({ control, name })
  return (
    <fieldset className="grid gap-3" data-testid={`${name}-list`}>
      <legend className="text-sm font-medium">{label}</legend>
      <p className="text-sm text-muted-foreground">{description}</p>
      {fields.map((item, index) => (
        <div
          key={item.id}
          className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-start"
        >
          <FormField
            control={control}
            name={`${name}.${index}.name`}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    {...field}
                    value={(field.value as string | undefined) ?? ''}
                    aria-label={t('name')}
                    placeholder={t('name')}
                    className="font-mono"
                    autoComplete="off"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name={`${name}.${index}.value`}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    {...field}
                    value={(field.value as string | null | undefined) ?? ''}
                    type={secret ? 'password' : 'text'}
                    aria-label={t('value')}
                    placeholder={t('value')}
                    autoComplete={secret ? 'new-password' : 'off'}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('remove', { name: label })}
            onClick={() => remove(index)}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= BROWSER_SCRIPT_MAX_VARIABLES}
          onClick={() => append({ name: '', value: '' })}
          data-testid={`${name}-add`}
        >
          <Plus aria-hidden />
          {t('add')}
        </Button>
      </div>
    </fieldset>
  )
}

/**
 * The Browser Script monitor's card (#139): start URL, remote browser, the script editor with its
 * variables and secrets, when to keep artifacts, and "Run now" (the form's ad-hoc test, #98).
 */
export function BrowserScriptCard({
  control,
  onRunNow,
  running,
  runSeconds,
  remoteBrowserLabel,
  remoteBrowserDescription,
}: {
  control: FormControlType
  onRunNow: () => void
  running: boolean
  runSeconds: number
  remoteBrowserLabel: string
  remoteBrowserDescription: string
}) {
  const t = useTranslations('monitors.form.browserScript')
  return (
    <Card data-testid="browser-script-card">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('startUrl')}</FormLabel>
                <FormControl>
                  <Input
                    type="url"
                    placeholder="https://example.com"
                    autoComplete="off"
                    {...field}
                    value={(field.value as string | null | undefined) ?? ''}
                  />
                </FormControl>
                <FormDescription>{t('startUrlDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="remoteBrowser"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{remoteBrowserLabel}</FormLabel>
                <FormControl>
                  <Input
                    placeholder="ws://browserless:3000"
                    autoComplete="off"
                    {...field}
                    value={(field.value as string | null | undefined) ?? ''}
                  />
                </FormControl>
                <FormDescription>{remoteBrowserDescription}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={control}
          name="browserScript"
          render={({ field }) => (
            <FormItem>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <FormLabel>{t('script')}</FormLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={running}
                  onClick={onRunNow}
                  data-testid="browser-script-run"
                >
                  {running ? <Loader2 className="animate-spin" aria-hidden /> : <FlaskConical />}
                  {running ? t('running', { seconds: runSeconds }) : t('runNow')}
                </Button>
              </div>
              <FormControl>
                <ScriptEditor
                  label={t('scriptLabel')}
                  name={field.name}
                  ref={field.ref}
                  value={(field.value as string | null | undefined) ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  data-testid="browser-script-editor"
                />
              </FormControl>
              <FormDescription>{t('scriptDescription')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <VariableList
          control={control}
          name="browserVariables"
          label={t('variables')}
          description={t('variablesDescription')}
        />
        <VariableList
          control={control}
          name="browserSecrets"
          label={t('secrets')}
          description={t('secretsDescription')}
          secret
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={control}
            name="browserArtifacts"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('artifacts')}</FormLabel>
                <Select value={field.value ?? 'failure'} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {BROWSER_ARTIFACT_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(`artifactsOption.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>{t('artifactsDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="ignoreTls"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start justify-between gap-4">
                <div className="grid gap-1">
                  <FormLabel>{t('ignoreTls')}</FormLabel>
                  <FormDescription>{t('ignoreTlsDescription')}</FormDescription>
                </div>
                <FormControl>
                  <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
      </CardContent>
    </Card>
  )
}
