import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { resetEnvCache } from '@/env'
import { guardedKafkaSocketFactory } from '@/server/monitor-types/kafka-producer'
import { pinGrpcTarget } from '@/server/monitor-types/grpc-keyword'
import { pinMqttUrl } from '@/server/monitor-types/mqtt'
import { pinRedisUrl } from '@/server/monitor-types/redis'

import { connectionStringDenial, connectionTargets } from './connection-hosts'
import { monitorTargetProblem } from './monitor-targets'
import {
  findBlockedMessage,
  guardedNetConnect,
  guardNetSocket,
  literalTargetDenial,
  resolveGuardedTarget,
} from './outbound-guard'

const VARS = ['MONITOR_DENY_PRIVATE_ADDRESSES', 'MONITOR_DENY_CIDRS', 'MONITOR_ALLOW_CIDRS']

function setGuard(vars: Record<string, string>) {
  for (const key of VARS) {
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  resetEnvCache()
}

afterEach(() => setGuard({}))

/** Resolves with the error a socket fails with (or null when it connects). */
const socketOutcome = (socket: net.Socket) =>
  new Promise<Error | null>((resolve) => {
    socket.once('error', resolve)
    socket.once('connect', () => {
      socket.destroy()
      resolve(null)
    })
  })

describe('connectionTargets', () => {
  it.each([
    ['postgres://u:p@db.example.com:5432/app', ['db.example.com'], false],
    ['postgres://u:p@h1:5432,h2:5433/app', ['h1', 'h2'], false],
    ['postgres://u@/app?host=/var/run/postgresql', [], true],
    ['postgresql:///app', ['localhost'], false],
    ['host=10.0.0.5 port=5432 dbname=app', ['10.0.0.5'], false],
    ['mysql://u:p@[::1]:3306/app', ['::1'], false],
    ['mysql://u:p@h/app?socketPath=/tmp/mysql.sock', ['h'], true],
    ['Server=tcp:sql.example.com,1433;Database=app;User Id=sa', ['sql.example.com'], false],
    ['Data Source=10.1.1.1\\SQLEXPRESS;Initial Catalog=app', ['10.1.1.1'], false],
    ['Server=np:\\\\.\\pipe\\sql\\query', [], true],
    [
      'mongodb://u:p@a:27017,b:27018/app?replicaSet=rs&proxyHost=127.0.0.1',
      ['a', 'b', '127.0.0.1'],
      false,
    ],
    ['mongodb://%2Ftmp%2Fmongodb-27017.sock/app', [], true],
    ['redis://:secret@cache:6379/0', ['cache'], false],
  ])('%s', (value, hosts, localSocket) => {
    expect(connectionTargets(value)).toMatchObject({ hosts, localSocket })
  })

  it('keeps the SRV name of mongodb+srv strings apart', () => {
    expect(connectionTargets('mongodb+srv://u:p@cluster0.example.net/app')).toMatchObject({
      hosts: [],
      srvName: 'cluster0.example.net',
    })
  })

  it('reports denied literals and local sockets for save-time feedback', () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect(connectionStringDenial('postgres://u:p@127.0.0.1/app')).toMatch(/^Blocked: 127.0.0.1/)
    expect(connectionStringDenial('host=/var/run/postgresql')).toMatch(/local socket/)
    expect(connectionStringDenial('postgres://u:p@db.example.com/app')).toBeNull()
    setGuard({})
    expect(connectionStringDenial('postgres://u:p@127.0.0.1/app')).toBeNull()
  })
})

describe('guard helpers', () => {
  it('are pass-through while the guard is off', async () => {
    expect(await resolveGuardedTarget('localhost')).toBeNull()
    expect(literalTargetDenial('127.0.0.1')).toBeNull()
    expect(await pinRedisUrl('redis://localhost:6379')).toEqual({ url: 'redis://localhost:6379' })
    expect(await pinGrpcTarget('localhost:50051')).toEqual({
      target: 'localhost:50051',
      channelOptions: {},
    })
  })

  it('pins names to their vetted address and keeps the name for TLS', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true', MONITOR_ALLOW_CIDRS: '127.0.0.0/8, ::1' })
    const redis = await pinRedisUrl('rediss://:pw@localhost:6380/1')
    expect(redis.servername).toBe('localhost')
    expect(redis.url).toMatch(/^rediss:\/\/:pw@(127\.0\.0\.1|\[::1\]):6380\/1$/)

    const grpc = await pinGrpcTarget('dns:///localhost:50051')
    expect(grpc.target).toMatch(/^(127\.0\.0\.1|\[::1\]):50051$/)
    expect(grpc.channelOptions).toEqual({
      'grpc.ssl_target_name_override': 'localhost',
      'grpc.default_authority': 'localhost:50051',
    })

    const mqtt = await pinMqttUrl('mqtts://localhost:8883')
    expect(mqtt.url).toMatch(/^mqtts:\/\/(127\.0\.0\.1|\[::1\]):8883$/)
    expect(mqtt.connectOptions).toEqual({ servername: 'localhost' })
  })

  it('refuses denied targets and non-DNS gRPC schemes', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    await expect(pinRedisUrl('redis://localhost:6379')).rejects.toThrow(/^Blocked: localhost/)
    await expect(pinGrpcTarget('unix:/tmp/grpc.sock')).rejects.toThrow(/gRPC target scheme/)
    await expect(pinMqttUrl('ws://127.0.0.1:9001/mqtt')).rejects.toThrow(/^Blocked: 127.0.0.1/)
  })

  it('fails guarded sockets for literals, names and unix sockets', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect((await socketOutcome(guardedNetConnect({ host: '127.0.0.1', port: 9 })))?.message).toBe(
      'Blocked: 127.0.0.1 resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
    expect((await socketOutcome(guardedNetConnect({ host: 'localhost', port: 9 })))?.message).toBe(
      'Blocked: localhost resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
    expect((await socketOutcome(guardedNetConnect({ path: '/tmp/x.sock' })))?.message).toMatch(
      /local socket is not allowed/,
    )

    const patched = guardNetSocket(new net.Socket())
    const outcome = socketOutcome(patched)
    patched.connect(5432, '::ffff:127.0.0.1')
    expect((await outcome)?.message).toMatch(/^Blocked: ::ffff:127.0.0.1/)

    const kafka = guardedKafkaSocketFactory({
      host: 'localhost',
      port: 9092,
      ssl: undefined as never,
      onConnect: () => undefined,
    })
    expect((await socketOutcome(kafka))?.message).toMatch(/^Blocked: localhost/)
  })

  it('finds the blocked message inside wrapped errors', () => {
    const inner = new Error(
      'Blocked: x resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
    expect(findBlockedMessage(new Error('fetch failed', { cause: inner }))).toBe(inner.message)
    expect(
      findBlockedMessage(new Error(`Database connection/query failed: ${inner.message}`)),
    ).toBe(inner.message)
    expect(findBlockedMessage(new AggregateError([new Error('a'), inner]))).toBe(inner.message)
    expect(findBlockedMessage(new Error('ECONNREFUSED'))).toBeNull()
  })
})

describe('monitorTargetProblem', () => {
  it('checks the target field of each monitor type', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    const problem = (monitor: Record<string, unknown>) =>
      monitorTargetProblem(monitor as never).then((p) => p?.path ?? null)

    expect(await problem({ type: 'http', url: 'http://2130706433/' })).toBe('url')
    expect(await problem({ type: 'http', url: 'http://[::1]:8080/' })).toBe('url')
    expect(await problem({ type: 'mqtt', hostname: 'mqtt://192.168.1.10' })).toBe('hostname')
    expect(
      await problem({
        type: 'dns',
        hostname: 'example.com',
        dnsResolveServer: '1.1.1.1, 10.0.0.53',
      }),
    ).toBe('dnsResolveServer')
    expect(
      await problem({ type: 'kafka-producer', kafkaProducerBrokers: ['172.17.0.1:9092'] }),
    ).toBe('kafkaProducerBrokers')
    expect(await problem({ type: 'rabbitmq', rabbitmqNodes: ['http://100.64.0.7:15672'] })).toBe(
      'rabbitmqNodes',
    )
    expect(await problem({ type: 'grpc-keyword', grpcUrl: 'dns:///127.0.0.1:50051' })).toBe(
      'grpcUrl',
    )
    expect(
      await problem({ type: 'redis', databaseConnectionString: 'redis://localhost:6379' }),
    ).toBe('databaseConnectionString')
    expect(
      await problem({
        type: 'http',
        url: 'https://example.com',
        authMethod: 'oauth2-cc',
        oauthTokenUrl: 'http://169.254.169.254/token',
      }),
    ).toBe('oauthTokenUrl')
    expect(await problem({ type: 'tailscale-ping', hostname: 'peer' })).toBe('type')
    expect(await problem({ type: 'http', url: 'https://example.com/' })).toBeNull()
    expect(await problem({ type: 'port', hostname: 'db.internal.example', port: 5432 })).toBeNull()
  })
})
