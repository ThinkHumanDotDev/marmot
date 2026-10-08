import { ASSERTION_KINDS, type AssertionResult } from '@/lib/validation/assertions'

/** Results stored on a heartbeat (`heartbeats.assertions`); anything malformed is skipped. */
export function parseAssertionResults(value: unknown): AssertionResult[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (row): row is AssertionResult =>
      !!row &&
      typeof row === 'object' &&
      (ASSERTION_KINDS as readonly string[]).includes((row as AssertionResult).kind) &&
      typeof (row as AssertionResult).passed === 'boolean',
  )
}
