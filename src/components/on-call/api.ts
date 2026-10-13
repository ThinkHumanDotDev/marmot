'use client'

import { useRouter } from 'next/navigation'
import * as React from 'react'

import { api } from '@/lib/api'
import type { EscalationPolicySummary, OnCallScheduleSummary } from '@/lib/on-call'
import { getSocket } from '@/lib/socket'
import type {
  PolicyInput,
  ScheduleInput,
  UpdatePolicyInput,
  UpdateScheduleInput,
} from '@/lib/validation/on-call'
import { RealtimeEvents, type RealtimePayloads } from '@/server/realtime/events'

const base = (orgId: string | number) => `/api/orgs/${encodeURIComponent(String(orgId))}/on-call`

/** Client wrapper over `/api/orgs/:orgId/on-call/**`. */
export const onCallApi = {
  createSchedule: (orgId: string | number, body: ScheduleInput) =>
    api.post<OnCallScheduleSummary>(`${base(orgId)}/schedules`, { ...body }),
  updateSchedule: (orgId: string | number, id: string, body: UpdateScheduleInput) =>
    api.patch<OnCallScheduleSummary>(`${base(orgId)}/schedules/${encodeURIComponent(id)}`, {
      ...body,
    }),
  deleteSchedule: (orgId: string | number, id: string) =>
    api.delete<void>(`${base(orgId)}/schedules/${encodeURIComponent(id)}`),
  createPolicy: (orgId: string | number, body: PolicyInput) =>
    api.post<EscalationPolicySummary>(`${base(orgId)}/escalation-policies`, { ...body }),
  updatePolicy: (orgId: string | number, id: string, body: UpdatePolicyInput) =>
    api.patch<EscalationPolicySummary>(
      `${base(orgId)}/escalation-policies/${encodeURIComponent(id)}`,
      { ...body },
    ),
  deletePolicy: (orgId: string | number, id: string) =>
    api.delete<void>(`${base(orgId)}/escalation-policies/${encodeURIComponent(id)}`),
}

/** Refreshes the page (debounced) when a schedule or policy of the organization changes. */
export function useOnCallRefresh(orgId: string | number): void {
  const router = useRouter()
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const socket = getSocket()
    const handler = (payload: RealtimePayloads['onCall']) => {
      if (payload.organizationId !== String(orgId)) return
      clearTimeout(timer)
      timer = setTimeout(() => router.refresh(), 300)
    }
    socket.on(RealtimeEvents.onCall, handler)
    return () => {
      clearTimeout(timer)
      socket.off(RealtimeEvents.onCall, handler)
    }
  }, [orgId, router])
}

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/** `datetime-local` value of an instant in the browser's zone. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
