/**
 * Helpers shared by the SQL database monitors (mysql, postgres, sqlserver).
 * Based on Uptime Kuma 2.5.5 `server/monitor-types/{mysql,postgres,mssql}.js` — Copyright (c) 2021
 * Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 */
import type { Monitor } from '@/payload-types'

export const DEFAULT_SQL_QUERY = 'SELECT 1'

/** The configured statement, or `SELECT 1` when the field is empty. */
export function sqlQueryOf(monitor: Pick<Monitor, 'databaseQuery'>): string {
  const query = monitor.databaseQuery?.trim()
  return query ? query : DEFAULT_SQL_QUERY
}

/** Heartbeat message for a query result: the row count when it is an array. */
export function describeRows(result: unknown): string {
  if (Array.isArray(result)) return `Rows: ${result.length}`
  return `No Error, but the result is not an array. Type: ${typeof result}`
}
