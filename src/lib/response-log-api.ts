/** Client-side calls for a monitor's per-check log (`/api/orgs/:orgId/monitors/:id/logs`, #97). */
import { api } from '@/lib/api'
import {
  responseLogQuery,
  type ResponseLogDetail,
  type ResponseLogPage,
  type ResponseLogQuery,
} from '@/lib/response-log'

type Id = string | number

export const responseLogApi = {
  list: (orgId: Id, monitorId: Id, filters: ResponseLogQuery, cursor?: string | null) =>
    api.get<ResponseLogPage>(
      `/api/orgs/${orgId}/monitors/${monitorId}/logs${responseLogQuery(filters, {
        cursor: cursor ?? undefined,
      })}`,
    ),
  get: (orgId: Id, monitorId: Id, heartbeatId: Id) =>
    api.get<ResponseLogDetail>(`/api/orgs/${orgId}/monitors/${monitorId}/logs/${heartbeatId}`),
}
