import { api } from '@/lib/api'
import type { ImportProviderId, ImportReport, ImportResource } from '@/lib/import-export'

type Id = string | number

/** Client calls for the Import / Export settings tab (`src/server/import-export`). */
export const importExportApi = {
  /** Parses and checks the file without writing anything. */
  dryRun: (orgId: Id, file: unknown) =>
    api.post<ImportReport>(`/api/orgs/${orgId}/import`, file as never, { query: { dryRun: 1 } }),
  /** Commits the import. */
  commit: (orgId: Id, file: unknown) =>
    api.post<ImportReport>(`/api/orgs/${orgId}/import`, file as never),
  /**
   * Reads the account from a hosted service and previews (`dryRun`) or commits the import. The
   * credentials are sent with each call and never stored by Marmot.
   */
  provider: (
    orgId: Id,
    provider: ImportProviderId,
    body: { credentials: Record<string, string>; resources: ImportResource[] },
    dryRun: boolean,
  ) =>
    api.post<ImportReport>(`/api/orgs/${orgId}/import/providers/${provider}`, body, {
      ...(dryRun ? { query: { dryRun: 1 } } : {}),
    }),
  exportUrl: (orgId: Id) => `/api/orgs/${orgId}/export`,
}
