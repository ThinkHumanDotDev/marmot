import { describe, expect, it } from 'vitest'

import { getStaticFormatter, getTranslator } from '@/i18n/translator'
import {
  createMaintenanceFormSchema,
  defaultMaintenanceValidationMessages,
  defaultMaintenanceValues,
  maintenanceFormSchema,
} from '@/lib/validation/maintenance'

const t = getTranslator('en')

describe('status page, maintenance and import messages (en)', () => {
  it('keeps the English plurals the components used to build by hand', () => {
    expect(t('statusPages.list.monitorCount', { monitors: 3, groups: 1 })).toBe('3 in 1 group')
    expect(t('statusPages.list.monitorCount', { monitors: 0, groups: 2 })).toBe('0 in 2 groups')
    expect(t('statusPages.groups.componentCount', { count: 1 })).toBe('1 component')
    expect(t('maintenance.list.monitorCount', { count: 2 })).toBe(' · 2 monitors')
    expect(t('maintenance.list.statusPageCount', { count: 1 })).toBe(' · 1 status page')
    expect(t('importExport.import.submit', { count: 1 })).toBe('Import 1 item')
    expect(t('importExport.import.success', { count: 4 })).toBe('Imported 4 items')
    expect(t('maintenance.picker.selected', { selected: 2, total: 5 })).toBe('2 of 5 selected')
  })

  it('formats maintenance windows in the given zone', () => {
    const format = getStaticFormatter('en', 'Europe/Berlin')
    const start = new Date('2026-10-06T08:00:00Z')
    const end = new Date('2026-10-06T09:30:00Z')
    expect(format.dateTimeRange(start, end, 'zoned')).toMatch(/10:00.*11:30.*GMT\+2/)
  })
})

describe('maintenance form schema messages', () => {
  it('uses English messages by default (route handlers)', () => {
    const result = maintenanceFormSchema.safeParse({ ...defaultMaintenanceValues(), title: '' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe(
      defaultMaintenanceValidationMessages.titleRequired,
    )
  })

  it('uses the messages it is given (the localised form)', () => {
    const schema = createMaintenanceFormSchema({
      ...defaultMaintenanceValidationMessages,
      titleRequired: 'Titel fehlt',
      cron: 'Ungültiger Cron-Ausdruck',
    })
    const result = schema.safeParse({
      ...defaultMaintenanceValues(),
      title: '',
      strategy: 'cron',
      cron: 'nope',
    })
    const messages = result.error?.issues.map((issue) => issue.message) ?? []
    expect(messages).toContain('Titel fehlt')
    expect(messages).toContain('Ungültiger Cron-Ausdruck')
  })
})
