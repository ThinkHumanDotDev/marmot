/**
 * Importers that pull from a hosted service's API (#120). Each provider reads a snapshot with the
 * caller's credentials (`fetch`) and maps it onto the shared `ImportPlan` (`plan`), which
 * `applyImportPlan` then previews or writes like a file import.
 *
 * Adding a provider = one file here + an entry in `PROVIDERS` and in `IMPORT_PROVIDER_INFO`
 * (`src/lib/import-export.ts`).
 */
import {
  IMPORT_PROVIDER_INFO,
  type ImportProviderId,
  type ImportResource,
} from '@/lib/import-export'

import type { ImportText } from '../text'
import type { ImportPlan } from '../types'
import { betterStackProvider } from './betterstack'
import { ProviderError, type FetchLike } from './fetch'
import type { Credentials, ImportProvider } from './shared'
import { statuspageProvider } from './statuspage'

export { ProviderError, type FetchLike, type ProviderErrorCode } from './fetch'
export type { Credentials, ImportProvider } from './shared'

export const PROVIDERS: Record<ImportProviderId, ImportProvider> = {
  statuspage: statuspageProvider as ImportProvider,
  betterstack: betterStackProvider as ImportProvider,
}

export interface ProviderImportInput {
  provider: ImportProviderId
  /** Held in memory for the duration of the call only. */
  credentials: Credentials
  resources: ImportResource[]
  fetch?: FetchLike
  now?: Date
}

/** Fetches from the provider and plans the import of the chosen `resources`. */
export async function planProviderImport(
  { provider, credentials, resources, fetch: fetchImpl = fetch, now }: ProviderImportInput,
  t: ImportText,
): Promise<ImportPlan> {
  const info = IMPORT_PROVIDER_INFO[provider]
  for (const field of info.credentials) {
    if (field.required && !credentials[field.name]?.trim()) throw new ProviderError('credentials')
  }
  const chosen = new Set(resources.filter((resource) => info.resources.includes(resource)))
  const implementation = PROVIDERS[provider]
  const snapshot = await implementation.fetch(credentials, chosen, fetchImpl)
  return implementation.plan(snapshot, chosen, t, now)
}
