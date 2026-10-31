import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hostSampleSchema, type HostSample } from '@/lib/host-metrics'

import { HostAgent, type Poster } from './agent'
import {
  HostCollector,
  parseMeminfo,
  parseNetstat,
  parseProcNetDev,
  parseSwapusage,
} from './collect'
import { containerFigures } from './docker'

describe('platform parsers', () => {
  it('reads /proc/meminfo in bytes', () => {
    expect(
      parseMeminfo('MemTotal:  16000 kB\nMemAvailable:  4000 kB\nHugePages_Total: 0\n'),
    ).toEqual({
      MemTotal: 16000 * 1024,
      MemAvailable: 4000 * 1024,
      HugePages_Total: 0,
    })
  })

  it('sums /proc/net/dev without loopback', () => {
    const text = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0',
      '  eth0: 1000 10 0 0 0 0 0 0 2000 10 0 0 0 0 0 0',
      '  eth1: 300 1 0 0 0 0 0 0 400 1 0 0 0 0 0 0',
    ].join('\n')
    expect(parseProcNetDev(text)).toEqual({ rx: 1300, tx: 2400 })
  })

  it('sums macOS netstat -ib link rows once per interface', () => {
    const text = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'lo0        16384 <Link#1>                         100     0       9000      100     0       9000     0',
      'en0        1500  <Link#6>    aa:bb:cc:dd:ee:ff    500     0       1000      400     0       3000     0',
      'en0        1500  192.168.1     192.168.1.20       500     -       1000      400     -       3000     -',
      'utun0      1380  <Link#7>                         10      0       50        10      0       70       0',
    ].join('\n')
    expect(parseNetstat(text)).toEqual({ rx: 1050, tx: 3070 })
  })

  it('reads macOS swap usage', () => {
    expect(
      parseSwapusage('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'),
    ).toEqual({ total: 2048 * 1024 ** 2, used: 1024.5 * 1024 ** 2 })
  })

  it('computes docker stats like the CLI', () => {
    expect(
      containerFigures({
        cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 20_000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
        memory_stats: { usage: 600, limit: 2000, stats: { inactive_file: 100 } },
      }),
    ).toEqual({ cpu: 40, memoryUsed: 500, memoryLimit: 2000 })
  })
})

describe('collector with a host root', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'marmot-host-'))
    await mkdir(path.join(root, 'proc/1/net'), { recursive: true })
    await mkdir(path.join(root, 'etc'), { recursive: true })
    await mkdir(path.join(root, 'sys/class/hwmon/hwmon0'), { recursive: true })
    await writeFile(
      path.join(root, 'proc/meminfo'),
      'MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 75 kB\n',
    )
    await writeFile(
      path.join(root, 'proc/1/net/dev'),
      'h1\nh2\n  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n',
    )
    await writeFile(path.join(root, 'etc/hostname'), 'the-host\n')
    await writeFile(
      path.join(root, 'etc/os-release'),
      'NAME=Debian\nPRETTY_NAME="Debian GNU/Linux 12"\n',
    )
    await writeFile(path.join(root, 'sys/class/hwmon/hwmon0/name'), 'coretemp\n')
    await writeFile(path.join(root, 'sys/class/hwmon/hwmon0/temp1_input'), '54500\n')
    await writeFile(path.join(root, 'sys/class/hwmon/hwmon0/temp1_label'), 'Package id 0\n')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads the host files under the root and reports rates from the second sample', async () => {
    const collector = new HostCollector({ root, platform: 'linux', disks: ['/', '/missing'] })
    const first = await collector.collect(1_000_000)
    expect(hostSampleSchema.safeParse(first).success).toBe(true)
    expect(first).toMatchObject({
      hostname: 'the-host',
      os: 'Debian GNU/Linux 12',
      memory: { total: 1000 * 1024, used: 750 * 1024 },
      swap: { total: 100 * 1024, used: 25 * 1024 },
      network: null,
      temperatures: [{ name: 'coretemp Package id 0', celsius: 54.5 }],
    })
    // `/` resolves to the root directory; `/missing` is skipped.
    expect(first.disks?.map((d) => d.mount)).toEqual(['/'])

    await writeFile(
      path.join(root, 'proc/1/net/dev'),
      'h1\nh2\n  eth0: 7000 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0\n',
    )
    const second = await collector.collect(1_010_000)
    expect(second.network).toEqual({ rx: 600, tx: 100 })
    expect(typeof second.cpu).toBe('number')
  })
})

describe('agent loop', () => {
  const sample: HostSample = { hostname: 'h', cpu: 5 }

  it('posts the sample with the token and follows the monitor interval', async () => {
    const post = vi.fn<Poster>(async () => ({ status: 200, body: { ok: true, interval: 30 } }))
    const agent = new HostAgent({
      url: 'https://marmot.example.com/base',
      token: 'token-123456',
      version: '1.2.3',
      interval: 60,
      collector: { collect: async () => ({ ...sample }) },
      post,
    })
    await agent.tick()
    expect(post).toHaveBeenCalledTimes(1)
    const [url, token, body, version] = post.mock.calls[0]
    expect(url.toString()).toBe('https://marmot.example.com/base/api/agent/v1/metrics')
    expect(token).toBe('token-123456')
    expect(JSON.parse(body)).toEqual(sample)
    expect(version).toBe('1.2.3')
    expect(agent.intervalSeconds).toBe(30)
  })

  it('survives an unreachable server and collector errors', async () => {
    const agent = new HostAgent({
      url: 'https://marmot.example.com',
      token: 'token-123456',
      version: '1',
      interval: 60,
      collector: { collect: async () => ({ ...sample }) },
      post: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(agent.tick()).resolves.toBeNull()
    const broken = new HostAgent({
      url: 'https://marmot.example.com',
      token: 'token-123456',
      version: '1',
      interval: 60,
      collector: {
        collect: async () => {
          throw new Error('boom')
        },
      },
    })
    await expect(broken.tick()).resolves.toBeNull()
  })
})
