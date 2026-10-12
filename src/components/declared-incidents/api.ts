'use client'

import * as React from 'react'

import { api } from '@/lib/api'
import type { DeclaredIncidentSummary } from '@/lib/declared-incidents'
import { getSocket } from '@/lib/socket'
import type {
  DeclareIncidentInput,
  UpdateDeclaredIncidentInput,
} from '@/lib/validation/declared-incident'
import { RealtimeEvents, type RealtimePayloads } from '@/server/realtime/events'

const base = (orgId: string | number) =>
  `/api/orgs/${encodeURIComponent(String(orgId))}/declared-incidents`

/** Client wrapper over `/api/orgs/:orgId/declared-incidents/**`. */
export const declaredApi = {
  declare: (orgId: string | number, body: Partial<DeclareIncidentInput>) =>
    api.post<DeclaredIncidentSummary>(base(orgId), { ...body }),
  update: (orgId: string | number, id: string, body: UpdateDeclaredIncidentInput) =>
    api.patch<DeclaredIncidentSummary>(`${base(orgId)}/${encodeURIComponent(id)}`, { ...body }),
  note: (orgId: string | number, id: string, message: string) =>
    api.post<DeclaredIncidentSummary>(`${base(orgId)}/${encodeURIComponent(id)}/notes`, {
      message,
    }),
}

/** Calls `onIncident` for every `declaredIncident` event of the organization. */
export function useDeclaredIncidentEvents(
  orgId: string | number,
  onIncident: (incident: DeclaredIncidentSummary) => void,
): void {
  const callback = React.useRef(onIncident)
  React.useEffect(() => {
    callback.current = onIncident
  })
  React.useEffect(() => {
    const socket = getSocket()
    const handler = (payload: RealtimePayloads['declaredIncident']) => {
      if (payload.organizationId === String(orgId)) callback.current(payload.incident)
    }
    socket.on(RealtimeEvents.declaredIncident, handler)
    return () => {
      socket.off(RealtimeEvents.declaredIncident, handler)
    }
  }, [orgId])
}

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback
