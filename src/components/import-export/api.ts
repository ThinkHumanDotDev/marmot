import { api } from '@/lib/api'
import type { ImportReport } from '@/lib/import-export'

type Id = string | number

/** Client calls for the Import / Export settings tab (`src/server/import-export`). */
export const importExportApi = {
  /** Parses and checks the file without writing anything. */
  dryRun: (orgId: Id, file: unknown) =>
    api.post<ImportReport>(`/api/orgs/${orgId}/import`, file as never, { query: { dryRun: 1 } }),
  /** Commits the import. */
  commit: (orgId: Id, file: unknown) =>
    api.post<ImportReport>(`/api/orgs/${orgId}/import`, file as never),
  exportUrl: (orgId: Id) => `/api/orgs/${orgId}/export`,
}
