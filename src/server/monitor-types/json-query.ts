/**
 * HTTP(s) JSON query monitor: evaluates a JSONata expression against the response and compares the
 * result with `expectedValue` using `jsonPathOperator`.
 *
 * Ported from Uptime Kuma 2.5.5 `src/util.ts` (`evaluateJsonQuery`) and the `json-query` branch of
 * `server/model/monitor.js` — Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 */
import type { AssertionResult } from '@/lib/validation/assertions'
import type { Monitor } from '@/payload-types'

import { evaluateJsonata } from './assertions'
import { performHttpCheck, type TypeCheckOutcome } from './http-request'
import { registerMonitorType } from './registry'
import { responseExcerpt } from './util'

export type JsonQueryOperator = '==' | '!=' | '<' | '>' | '<=' | '>=' | 'contains'

/**
 * Evaluate a JSON query expression against the provided data.
 * @throws Error if the evaluation returns undefined or a non-primitive value.
 */
export async function evaluateJsonQuery(
  data: unknown,
  jsonPath: string | null | undefined,
  jsonPathOperator: string,
  expectedValue: unknown,
): Promise<{ status: boolean; response: unknown }> {
  // Attempt to parse data as JSON; if unsuccessful, handle based on data type.
  let response: unknown
  try {
    response = JSON.parse(data as string)
  } catch {
    response =
      (typeof data === 'object' || typeof data === 'number') && !Buffer.isBuffer(data)
        ? data
        : String(data)
  }

  try {
    // If a JSON path is provided, pre-evaluate the data using it.
    response = jsonPath ? await evaluateJsonata(jsonPath, response) : response

    if (response === null || response === undefined) {
      throw new Error('Empty or undefined response. Check query syntax and response structure')
    }

    // JSONata filter expressions like .[predicate] always return arrays.
    if (Array.isArray(response)) {
      const responseStr = JSON.stringify(response)
      const truncated =
        responseStr.length > 25 ? responseStr.substring(0, 25) + '...]' : responseStr
      throw new Error(
        `JSON query returned the array ${truncated}, but a primitive value is required. ` +
          'Modify your query to return a single value via [0] to get the first element or use an aggregation like $count(), $sum() or $boolean().',
      )
    }

    if (
      typeof response === 'object' ||
      response instanceof Date ||
      typeof response === 'function'
    ) {
      throw new Error(
        `The post-JSON query evaluated response from the server is of type ${typeof response}, which cannot be directly compared to the expected value`,
      )
    }

    let jsonQueryExpression: string
    switch (jsonPathOperator) {
      case '>':
      case '>=':
      case '<':
      case '<=':
        jsonQueryExpression = `$number($.value) ${jsonPathOperator} $number($.expected)`
        break
      case '!=':
        jsonQueryExpression = '$.value != $.expected'
        break
      case '==':
        jsonQueryExpression = '$.value = $.expected'
        break
      case 'contains':
        jsonQueryExpression = '$contains($.value, $.expected)'
        break
      default:
        throw new Error(`Invalid condition ${jsonPathOperator}`)
    }

    const status = (await evaluateJsonata(jsonQueryExpression, {
      value: String(response),
      expected: String(expectedValue ?? ''),
    })) as boolean | undefined

    if (status === undefined) {
      throw new Error(
        'Query evaluation returned undefined. Check query syntax and the structure of the response data',
      )
    }

    return { status, response }
  } catch (err) {
    const printable = responseExcerpt(JSON.stringify(response) ?? String(response))
    throw new Error(
      `Error evaluating JSON query: ${err instanceof Error ? err.message : String(err)}. Response from server was: ${printable}`,
    )
  }
}

const OPERATOR_COMPARATOR: Record<string, AssertionResult['comparator']> = {
  '==': 'eq',
  '!=': 'not_eq',
  '<': 'lt',
  '>': 'gt',
  '<=': 'lte',
  '>=': 'gte',
  contains: 'contains',
}

/** The JSON query verdict of an HTTP response, reported as a legacy `jsonBody` assertion (#96). */
export async function jsonQueryOutcome(
  monitor: Pick<Monitor, 'jsonPath' | 'jsonPathOperator' | 'expectedValue'>,
  body: string,
): Promise<TypeCheckOutcome> {
  const operator = monitor.jsonPathOperator ?? '=='
  const expected = monitor.expectedValue ?? ''
  const base = {
    kind: 'jsonBody' as const,
    target: monitor.jsonPath || null,
    comparator: OPERATOR_COMPARATOR[operator] ?? 'eq',
    expected,
  }
  try {
    const { status, response } = await evaluateJsonQuery(body, monitor.jsonPath, operator, expected)
    const actual = responseExcerpt(response)
    return {
      result: { ...base, actual, passed: Boolean(status) },
      msg: status
        ? `JSON query passes (comparing ${actual} ${operator} ${expected})`
        : `JSON query does not pass (comparing ${actual} ${operator} ${expected})`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { result: { ...base, actual: null, passed: false, error: message }, msg: message }
  }
}

registerMonitorType({
  name: 'json-query',
  label: 'HTTP(s) - Json Query',
  group: 'general',
  async check(ctx) {
    await performHttpCheck(ctx, {
      typeCheck: async (res) => jsonQueryOutcome(ctx.monitor, res.body),
    })
    ctx.heartbeat.status = 'up'
  },
})
