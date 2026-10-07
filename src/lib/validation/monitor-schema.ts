import { createTranslator } from 'next-intl'

import en from '@/i18n/messages/en.json'

import { createMonitorFormSchema, type MonitorValidationKey } from './monitor'

/**
 * The monitor form schema with English messages (`monitors.validation` in the English catalogue),
 * for the route handlers, imports and tests. Lives apart from `./monitor` because that module is
 * bundled into the form: importing the catalogue there would ship it to the browser.
 */
const translate = createTranslator({ locale: 'en', messages: en, namespace: 'monitors.validation' })

export const monitorFormSchema = createMonitorFormSchema(
  (key: MonitorValidationKey, values?: Record<string, string | number>) => translate(key, values),
)
