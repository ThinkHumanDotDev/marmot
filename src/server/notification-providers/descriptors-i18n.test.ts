import { describe, expect, it, vi } from 'vitest'

import en from '@/i18n/messages/en.json'
import { describeProvider, localizeDescriptor } from './describe'
import { describeNotificationProviders, listNotificationProviders } from './index'

type Catalogue = Record<
  string,
  {
    label: string
    fields: Record<
      string,
      {
        label: string
        description?: string
        placeholder?: string
        options?: Record<string, string>
      }
    >
  }
>

const catalogue = en.notifications.providers as unknown as Catalogue

describe('notification provider descriptors', () => {
  it('has a catalogue entry for every provider, field and option', () => {
    for (const provider of listNotificationProviders()) {
      const entry = catalogue[provider.name]
      expect(entry, provider.name).toBeDefined()
      const descriptor = describeProvider(provider)
      for (const field of descriptor.fields) {
        const text = entry.fields[field.name]
        expect(text, `${provider.name}.${field.name}`).toBeDefined()
        expect(Boolean(text.description), `${provider.name}.${field.name}.description`).toBe(
          Boolean(field.description),
        )
        for (const value of Object.keys(field.options ?? {})) {
          expect(text.options?.[value], `${provider.name}.${field.name}.${value}`).toBeDefined()
        }
      }
      expect(Object.keys(entry.fields).sort()).toEqual(descriptor.fields.map((f) => f.name).sort())
    }
    expect(Object.keys(catalogue).sort()).toEqual(
      listNotificationProviders()
        .map((p) => p.name)
        .sort(),
    )
  })

  it('renders English byte-identical to the providers’ own labels', () => {
    for (const provider of listNotificationProviders()) {
      const descriptor = describeProvider(provider)
      expect(localizeDescriptor(descriptor, 'en')).toEqual(descriptor)
    }
  })

  it('takes the text from the catalogue of the requested locale', async () => {
    vi.resetModules()
    vi.doMock('@/i18n/messages', async (importOriginal) => {
      const original = await importOriginal<typeof import('@/i18n/messages')>()
      const xx = structuredClone(en) as typeof en & { notifications: { providers: Catalogue } }
      const discord = xx.notifications.providers.discord
      discord.label = 'Diskord'
      discord.fields.webhookUrl.label = 'Webhook-Adresse'
      discord.fields.messageFormat.options!.normal = 'Einbettung'
      return {
        ...original,
        getMessages: (locale: string) => (locale === 'xx' ? xx : original.getMessages('en')),
      }
    })
    const { describeNotificationProviders: describeIn } = await import('./index')
    const discord = describeIn('xx' as never).find((d) => d.name === 'discord')!
    expect(discord.label).toBe('Diskord')
    expect(discord.fields.find((f) => f.name === 'webhookUrl')?.label).toBe('Webhook-Adresse')
    expect(discord.fields.find((f) => f.name === 'messageFormat')?.options?.normal).toBe(
      'Einbettung',
    )
    // Technical placeholders are not in the catalogue and stay as declared.
    expect(discord.fields.find((f) => f.name === 'webhookUrl')?.placeholder).toBe(
      'https://discord.com/api/webhooks/…',
    )
    vi.doUnmock('@/i18n/messages')
    vi.resetModules()
  })

  it('sorts by group, then by label', () => {
    const descriptors = describeNotificationProviders()
    const keys = descriptors.map((d) => `${d.group}/${d.label}`)
    const collator = new Intl.Collator('en')
    expect(
      [...keys].sort((a, b) => {
        const [ga, la] = a.split('/')
        const [gb, lb] = b.split('/')
        return collator.compare(ga, gb) || collator.compare(la, lb)
      }),
    ).toEqual(keys)
  })
})
