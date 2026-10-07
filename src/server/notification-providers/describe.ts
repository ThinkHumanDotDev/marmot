import type { z } from 'zod'

import type { Locale } from '@/i18n/locales'
import { serverTranslator } from '@/server/i18n'

import type {
  NotificationFieldMeta,
  NotificationProvider,
  NotificationProviderGroup,
} from './types'

/**
 * Serialisable description of a provider's config form, derived from its zod `configSchema`.
 * The server builds these and hands them to the client; the dynamic form never imports providers.
 */
export type NotificationFieldKind = 'string' | 'number' | 'boolean' | 'enum'

export interface NotificationFieldDescriptor extends NotificationFieldMeta {
  name: string
  kind: NotificationFieldKind
  required: boolean
  /** Enum values in declaration order. */
  values?: string[]
  defaultValue?: string | number | boolean
}

export interface NotificationProviderDescriptor {
  name: string
  label: string
  group: NotificationProviderGroup
  docsUrl?: string
  fields: NotificationFieldDescriptor[]
}

type ZodDef = {
  type: string
  innerType?: z.ZodTypeAny
  defaultValue?: unknown
  entries?: Record<string, string | number>
  values?: unknown[]
  checks?: unknown[]
}

const defOf = (schema: z.ZodTypeAny): ZodDef =>
  (schema as unknown as { _zod: { def: ZodDef } })._zod.def

const humanize = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

/**
 * Unwrap `.optional()` / `.nullable()` / `.default()` wrappers and report the inner scalar kind.
 * Throws for shapes the form cannot render so a mis-declared provider fails at boot, not in the UI.
 */
export function describeField(
  name: string,
  schema: z.ZodTypeAny,
  meta: NotificationFieldMeta | undefined,
): NotificationFieldDescriptor {
  let current = schema
  let required = true
  let defaultValue: unknown

  for (;;) {
    const def = defOf(current)
    if (def.type === 'optional' || def.type === 'nullable') {
      required = false
      current = def.innerType as z.ZodTypeAny
      continue
    }
    if (def.type === 'default') {
      required = false
      defaultValue = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue
      current = def.innerType as z.ZodTypeAny
      continue
    }
    break
  }

  const def = defOf(current)
  const base: Omit<NotificationFieldDescriptor, 'kind'> = {
    name,
    required,
    label: meta?.label ?? humanize(name),
    ...(meta?.description ? { description: meta.description } : {}),
    ...(meta?.placeholder ? { placeholder: meta.placeholder } : {}),
    ...(meta?.secret ? { secret: true } : {}),
    ...(meta?.multiline ? { multiline: true } : {}),
    ...(meta?.options ? { options: meta.options } : {}),
    ...(meta?.template ? { template: meta.template } : {}),
    ...(meta?.templateHtmlWhen ? { templateHtmlWhen: meta.templateHtmlWhen } : {}),
    ...(defaultValue !== undefined
      ? { defaultValue: defaultValue as string | number | boolean }
      : {}),
  }

  switch (def.type) {
    case 'string':
      return { ...base, kind: 'string' }
    case 'number':
      return { ...base, kind: 'number' }
    case 'boolean':
      return { ...base, kind: 'boolean' }
    case 'enum': {
      const values = Object.values(def.entries ?? {}).map(String)
      return { ...base, kind: 'enum', values }
    }
    case 'literal':
      return { ...base, kind: 'enum', values: (def.values ?? []).map(String) }
    default:
      throw new Error(
        `Notification config field "${name}" has unsupported schema type "${def.type}" (use string, number, boolean or enum)`,
      )
  }
}

export function describeProvider(provider: NotificationProvider): NotificationProviderDescriptor {
  const def = defOf(provider.configSchema)
  if (def.type !== 'object') {
    throw new Error(`Notification provider "${provider.name}" configSchema must be a z.object()`)
  }
  const shape = (provider.configSchema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape
  const fields = Object.entries(shape).map(([name, schema]) =>
    describeField(name, schema, provider.fieldMeta?.[name]),
  )
  return {
    name: provider.name,
    label: provider.label,
    group: provider.group,
    ...(provider.docsUrl ? { docsUrl: provider.docsUrl } : {}),
    fields,
  }
}

/**
 * `descriptor` with its user-facing text (provider label, field labels, descriptions, prose
 * placeholders and option labels) from `notifications.providers.<name>` in `locale`. Text without
 * a catalogue entry (technical placeholders such as URLs) is kept as declared by the provider.
 */
export function localizeDescriptor(
  descriptor: NotificationProviderDescriptor,
  locale: Locale,
): NotificationProviderDescriptor {
  // Keys are built at runtime from provider and field names, so they cannot be type-checked here;
  // `notification-providers.test.ts` checks that the English catalogue covers every provider.
  const t = serverTranslator(locale) as unknown as {
    (key: string): string
    has(key: string): boolean
  }
  const text = (key: string, fallback: string) => (t.has(key) ? t(key) : fallback)
  const base = `notifications.providers.${descriptor.name}`
  return {
    ...descriptor,
    label: text(`${base}.label`, descriptor.label),
    fields: descriptor.fields.map((field) => {
      const key = `${base}.fields.${field.name}`
      return {
        ...field,
        label: text(`${key}.label`, field.label),
        ...(field.description
          ? { description: text(`${key}.description`, field.description) }
          : {}),
        ...(field.placeholder
          ? { placeholder: text(`${key}.placeholder`, field.placeholder) }
          : {}),
        ...(field.options
          ? {
              options: Object.fromEntries(
                Object.entries(field.options).map(([value, label]) => [
                  value,
                  text(`${key}.options.${value}`, label),
                ]),
              ),
            }
          : {}),
      }
    }),
  }
}
