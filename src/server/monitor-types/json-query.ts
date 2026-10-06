/**
 * HTTP(s) JSON query monitor: evaluates a JSONata expression against the response and compares the
 * result with `expectedValue` using `jsonPathOperator`.
 *
 * Ported from Uptime Kuma 2.5.5 `src/util.ts` (`evaluateJsonQuery`) and the `json-query` branch of
 * `server/model/monitor.js` — Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 */
import jsonata from 'jsonata'

import { performHttpCheck } from './http-request'
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
    response = jsonPath ? await jsonata(jsonPath).evaluate(response) : response

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

    const status = (await jsonata(jsonQueryExpression).evaluate({
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

registerMonitorType({
  name: 'json-query',
  label: 'HTTP(s) - Json Query',
  group: 'general',
  async check(ctx) {
    const res = await performHttpCheck(ctx)
    const operator = ctx.monitor.jsonPathOperator ?? '=='
    const expected = ctx.monitor.expectedValue ?? ''
    const { status, response } = await evaluateJsonQuery(
      res.body,
      ctx.monitor.jsonPath,
      operator,
      expected,
    )
    if (status) {
      ctx.heartbeat.status = 'up'
      ctx.heartbeat.msg = `JSON query passes (comparing ${responseExcerpt(response)} ${operator} ${expected})`
      return
    }
    throw new Error(
      `JSON query does not pass (comparing ${responseExcerpt(response)} ${operator} ${expected})`,
    )
  },
})
