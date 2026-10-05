import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { evaluateKeyword, lcFirst } from './grpc-keyword'
import './index'

const PROTO = `
syntax = "proto3";
package health.v1;
service Health {
  rpc Check (HealthCheckRequest) returns (HealthCheckResponse);
}
message HealthCheckRequest { string service = 1; }
message HealthCheckResponse { string status = 1; }
`

describe('grpc-keyword monitor', () => {
  afterEach(() => {
    vi.doUnmock('@grpc/grpc-js')
  })

  it('judges keywords, honouring invertKeyword', () => {
    expect(
      evaluateKeyword('{"status":"SERVING"}', { keyword: 'SERVING', invertKeyword: false }),
    ).toBe('{"status":"SERVING"}, keyword [SERVING] is found')
    expect(() =>
      evaluateKeyword('{"status":"NOT_SERVING"}', { keyword: 'SERVING', invertKeyword: true }),
    ).toThrow('keyword [SERVING] is present in [{"status":"NOT_SERVING"}]')
    expect(() =>
      evaluateKeyword('x'.repeat(80), { keyword: 'nope', invertKeyword: false }),
    ).toThrow(/keyword \[nope\] is not in \[x{47}\.\.\.\]/)
    expect(lcFirst('Check')).toBe('check')
  })

  it('requires the gRPC settings', async () => {
    await expect(runCheck(makeMonitor({ type: 'grpc-keyword', grpcUrl: null }))).rejects.toThrow(
      'gRPC URL is required',
    )
    await expect(
      runCheck(makeMonitor({ type: 'grpc-keyword', grpcUrl: 'localhost:50051', grpcProtobuf: '' })),
    ).rejects.toThrow('Proto definition is required')
  })

  it('names the available methods when the method does not exist', async () => {
    const monitor = makeMonitor({
      type: 'grpc-keyword',
      grpcUrl: `${CLOSED_HOST}:${CLOSED_PORT}`,
      grpcProtobuf: PROTO,
      grpcServiceName: 'health.v1.Health',
      grpcMethod: 'Watch',
      keyword: 'SERVING',
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      'Method "Watch" not found in service health.v1.Health (check)',
    )
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'grpc-keyword',
      grpcUrl: `${CLOSED_HOST}:${CLOSED_PORT}`,
      grpcProtobuf: PROTO,
      grpcServiceName: 'health.v1.Health',
      grpcMethod: 'Check',
      grpcBody: '{"service": "api"}',
      keyword: 'SERVING',
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/UNAVAILABLE|ECONNREFUSED|Deadline/i)
  })

  it('explains how to install the client when @grpc/grpc-js is missing', async () => {
    vi.doMock('@grpc/grpc-js', () => {
      throw Object.assign(new Error("Cannot find package '@grpc/grpc-js'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'grpc-keyword',
      grpcUrl: `${CLOSED_HOST}:${CLOSED_PORT}`,
      grpcProtobuf: PROTO,
      grpcServiceName: 'health.v1.Health',
      grpcMethod: 'check',
      keyword: 'SERVING',
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Install @grpc\/grpc-js to use the gRPC monitor/,
    )
  })
})
