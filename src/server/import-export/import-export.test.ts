import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { detectImportFormat } from '@/lib/import-export'
import { getNotificationProvider } from '@/server/notification-providers'

import { KUMA_NOTIFICATION_MAPPINGS, mapKumaNotificationConfig } from './kuma-notifications'
import { parseMarmotExport } from './marmot'
import { ImportFormatError } from './types'
import { parseUptimeKumaBackup } from './uptime-kuma'

const fixture = () =>
  JSON.parse(
    readFileSync(path.join(process.cwd(), 'tests/fixtures/uptime-kuma-backup.json'), 'utf8'),
  ) as Record<string, unknown>

describe('import format detection', () => {
  it('recognises Uptime Kuma backups and Marmot exports', () => {
    expect(detectImportFormat(fixture())).toBe('uptime-kuma')
    expect(detectImportFormat({ format: 'marmot', version: 1 })).toBe('marmot')
    expect(detectImportFormat({ hello: 'world' })).toBeNull()
    expect(detectImportFormat([])).toBeNull()
    expect(detectImportFormat('nope')).toBeNull()
  })

  it('rejects files of the wrong shape with ImportFormatError', () => {
    expect(() => parseUptimeKumaBackup({ monitors: [] })).toThrow(ImportFormatError)
    expect(() => parseMarmotExport(fixture())).toThrow(ImportFormatError)
    expect(() => parseMarmotExport({ format: 'marmot', version: 2 })).toThrow(ImportFormatError)
  })
})

describe('Uptime Kuma backup parser', () => {
  const plan = parseUptimeKumaBackup(fixture())
  const byName = (name: string) => plan.monitors.find((m) => m.data.name === name)!

  it('maps every supported monitor and skips unsupported or invalid ones with a reason', () => {
    expect(plan.format).toBe('uptime-kuma')
    expect(plan.monitors.map((m) => m.data.name)).toEqual([
      'Production',
      'Website',
      'API keyword',
      'JSON health',
      'SSH',
      'Gateway ping',
      'DNS example.com',
      'Nightly backup job',
    ])
    expect(plan.skipped.monitors).toEqual([
      { name: 'Registry container', reason: expect.stringContaining('Docker Container') },
      {
        name: 'Broken monitor',
        reason: expect.stringMatching(/Invalid monitor: url: URL is required/),
      },
    ])
  })

  it('rebuilds group membership from the backup ids', () => {
    expect(byName('Production').data.type).toBe('group')
    expect(byName('Production').parentKey).toBeNull()
    expect(byName('Website').parentKey).toBe('1')
    expect(byName('API keyword').parentKey).toBe('1')
    expect(byName('JSON health').parentKey).toBeNull()
    // Every planned monitor's parent is itself a planned group.
    const groups = new Set(plan.monitors.filter((m) => m.data.type === 'group').map((m) => m.key))
    for (const monitor of plan.monitors) {
      if (monitor.parentKey) expect(groups.has(monitor.parentKey)).toBe(true)
    }
  })

  it('maps HTTP options, status codes, headers and authentication', () => {
    const website = byName('Website').data
    expect(website).toMatchObject({
      type: 'http',
      url: 'https://example.com/',
      description: 'Marketing site',
      interval: 120,
      retryInterval: 30,
      maxRetries: 2,
      resendInterval: 10,
      timeout: 30,
      maxRedirects: 5,
      acceptedStatusCodes: ['200-299', '304'],
      expiryNotification: true,
      headers: '{"X-Source": "uptime-kuma"}',
      weight: 1000,
      active: true,
      authMethod: 'none',
    })

    const keyword = byName('API keyword').data
    expect(keyword).toMatchObject({
      type: 'keyword',
      method: 'POST',
      keyword: '"status":"ok"',
      invertKeyword: false,
      ignoreTls: true,
      body: '{"ping": true}',
      authMethod: 'basic',
      basicAuthUser: 'probe',
      basicAuthPass: 's3cret',
    })

    const json = byName('JSON health').data
    expect(json).toMatchObject({
      type: 'json-query',
      jsonPath: '$.status',
      jsonPathOperator: '==',
      expectedValue: 'ok',
      authMethod: 'oauth2-cc',
      oauthTokenUrl: 'https://auth.example.com/token',
      oauthClientId: 'client',
      oauthClientSecret: 'secret',
      oauthScopes: 'read',
      oauthAuthMethod: 'client_secret_post',
    })
  })

  it('maps host monitors, DNS options, the paused flag and the push token', () => {
    expect(byName('SSH').data).toMatchObject({
      type: 'port',
      hostname: 'bastion.example.com',
      port: 22,
      active: false,
    })
    expect(byName('DNS example.com').data).toMatchObject({
      type: 'dns',
      hostname: 'example.com',
      port: 53,
      dnsResolveServer: '8.8.8.8',
      dnsResolveType: 'MX',
      interval: 300,
    })
    expect(byName('Nightly backup job').data).toMatchObject({ type: 'push', interval: 86400 })
    expect(byName('Nightly backup job').pushToken).toBe('kumaPushToken0123')
    expect(byName('Website').pushToken).toBeNull()
  })

  it('raises intervals below the 20 s minimum and reports it', () => {
    expect(byName('Gateway ping').data).toMatchObject({
      interval: 20,
      retryInterval: 20,
      maxRetries: 3,
    })
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"Gateway ping": interval raised from 15s'),
        expect.stringContaining('"Gateway ping": retryInterval raised from 15s'),
      ]),
    )
  })

  it('maps notifications of supported providers and skips the rest with a reason', () => {
    expect(plan.notifications).toHaveLength(2)
    const slack = plan.notifications.find((n) => n.name === 'Ops Slack')!
    expect(slack).toMatchObject({
      key: '1',
      type: 'slack',
      isDefault: true,
      active: true,
      config: {
        webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX',
        channel: '#ops',
        username: 'Uptime Kuma',
        iconEmoji: ':rotating_light:',
        richMessage: true,
        channelNotify: true,
        useTemplate: false,
      },
    })
    const telegram = plan.notifications.find((n) => n.name === 'Alerts Telegram')!
    expect(telegram).toMatchObject({
      key: '2',
      type: 'telegram',
      isDefault: false,
      config: {
        botToken: '123456:ABC-DEF',
        chatId: '-1001234567890',
        messageThreadId: '42',
        sendSilently: true,
        protectContent: false,
        serverUrl: 'https://api.telegram.org',
      },
    })
    expect(plan.skipped.notifications).toEqual([
      {
        name: 'PagerTree escalation',
        reason: expect.stringContaining('"PagerTree" is not supported'),
      },
      { name: 'Broken mail', reason: expect.stringMatching(/Invalid smtp settings: to/) },
    ])
  })

  it('links monitors to imported notifications and drops links to skipped ones', () => {
    expect(byName('Website').notificationKeys).toEqual(['1', '2'])
    expect(byName('API keyword').notificationKeys).toEqual(['1'])
    expect(byName('Gateway ping').notificationKeys).toEqual(['2'])
    expect(byName('Production').notificationKeys).toEqual([])
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/1 monitor → notification link dropped/)]),
    )
  })

  it('reports tags as skipped instead of failing', () => {
    expect(plan.skipped.tags).toEqual([
      { name: 'prod', reason: 'Tags are not supported yet (2 monitor assignments skipped)' },
      { name: 'region', reason: 'Tags are not supported yet (1 monitor assignment skipped)' },
      { name: 'unused', reason: 'Tags are not supported yet' },
    ])
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Skipped 3 tags')]),
    )
  })

  it('imports the extended monitor types with their Kuma columns', () => {
    const base = { active: true, interval: 60, retryInterval: 60, maxretries: 0 }
    const out = parseUptimeKumaBackup({
      notificationList: [],
      monitorList: [
        {
          ...base,
          id: 1,
          name: 'Orders DB',
          type: 'postgres',
          databaseConnectionString: 'postgres://ro:pw@db:5432/orders',
          databaseQuery: 'SELECT 1',
        },
        {
          ...base,
          id: 2,
          name: 'Events',
          type: 'kafka-producer',
          kafkaProducerBrokers: ['kafka-1:9092', 'kafka-2:9092'],
          kafkaProducerTopic: 'health',
          kafkaProducerMessage: 'ping',
          kafkaProducerSaslOptions: { mechanism: 'plain', username: 'u', password: 'p' },
        },
        {
          ...base,
          id: 3,
          name: 'Switch',
          type: 'snmp',
          hostname: '10.0.0.2',
          port: 161,
          snmpOid: '1.3.6.1.2.1.1.3.0',
          snmpVersion: '2c',
          radiusPassword: 'public',
        },
        {
          ...base,
          id: 4,
          name: 'Broker',
          type: 'rabbitmq',
          rabbitmqNodes: '["http://rabbit:15672"]',
          rabbitmqUsername: 'guest',
          rabbitmqPassword: 'guest',
        },
        { ...base, id: 5, name: 'Browser', type: 'real-browser', url: 'https://example.com' },
      ],
    })
    expect(out.skipped.monitors).toEqual([
      { name: 'Browser', reason: expect.stringContaining('remote browser URL') },
    ])
    const byKey = (key: string) => out.monitors.find((m) => m.key === key)!.data
    expect(byKey('1')).toMatchObject({
      type: 'postgres',
      databaseConnectionString: 'postgres://ro:pw@db:5432/orders',
      databaseQuery: 'SELECT 1',
    })
    expect(byKey('2')).toMatchObject({
      kafkaProducerBrokers: ['kafka-1:9092', 'kafka-2:9092'],
      kafkaProducerTopic: 'health',
      kafkaProducerSaslOptions: '{"mechanism":"plain","username":"u","password":"p"}',
    })
    expect(byKey('3')).toMatchObject({ snmpVersion: '2c', snmpCommunity: 'public' })
    expect(byKey('4')).toMatchObject({ rabbitmqNodes: ['http://rabbit:15672'] })
  })

  it('accepts notification configs that are already objects', () => {
    const json = fixture()
    json.notificationList = [
      {
        id: 7,
        name: 'Gotify',
        active: true,
        isDefault: false,
        config: {
          type: 'gotify',
          gotifyserverurl: 'https://gotify.example.com',
          gotifyapplicationToken: 'tok',
          gotifyPriority: '5',
        },
      },
    ]
    json.monitorList = []
    const out = parseUptimeKumaBackup(json)
    expect(out.notifications).toEqual([
      expect.objectContaining({
        key: '7',
        type: 'gotify',
        config: { serverUrl: 'https://gotify.example.com', appToken: 'tok', priority: 5 },
      }),
    ])
  })
})

describe('Kuma notification mapping table', () => {
  it('only targets providers that exist and keys their schemas know', () => {
    for (const [kumaType, mapping] of Object.entries(KUMA_NOTIFICATION_MAPPINGS)) {
      const provider = getNotificationProvider(mapping.type)
      expect(provider, `${kumaType} → ${mapping.type}`).toBeDefined()
      const shape = (provider!.configSchema as unknown as { shape: Record<string, unknown> }).shape
      for (const marmotKey of Object.keys(mapping.fields)) {
        expect(shape, `${mapping.type}.${marmotKey}`).toHaveProperty(marmotKey)
      }
    }
  })

  it('translates "0" auto-resolve values and the Discord message format fallback', () => {
    expect(
      mapKumaNotificationConfig('PagerDuty', {
        pagerdutyIntegrationKey: 'k',
        pagerdutyAutoResolve: '0',
      }),
    ).toEqual({ type: 'pagerduty', config: { integrationKey: 'k', autoResolve: 'none' } })
    expect(
      mapKumaNotificationConfig('discord', {
        discordWebhookUrl: 'https://discord.com/api/webhooks/1/x',
        discordUseMessageTemplate: true,
        discordMessageTemplate: '{{ msg }}',
      }),
    ).toEqual({
      type: 'discord',
      config: {
        webhookUrl: 'https://discord.com/api/webhooks/1/x',
        messageTemplate: '{{ msg }}',
        messageFormat: 'custom',
      },
    })
    expect(mapKumaNotificationConfig('Webpush', { subscription: '{}' })).toBeNull()
  })
})

describe('Marmot export parser', () => {
  const file = {
    format: 'marmot',
    version: 1,
    exportedAt: '2026-10-05T00:00:00.000Z',
    notifications: [
      { id: 5, name: 'Hooks', type: 'webhook', config: { url: 'https://example.com/hook' } },
      { id: 6, name: 'Nope', type: 'carrier-pigeon', config: {} },
    ],
    monitors: [
      {
        id: 'g1',
        name: 'Group',
        type: 'group',
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
        notifications: [],
      },
      {
        id: 'm1',
        name: 'Site',
        type: 'http',
        url: 'https://example.com',
        parent: 'g1',
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
        notifications: [5, 6],
      },
      {
        id: 'm2',
        name: 'Orphan',
        type: 'ping',
        hostname: 'h',
        parent: 'missing',
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
      },
      {
        id: 'm3',
        name: 'Bad',
        type: 'port',
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
      },
      {
        id: 'p1',
        name: 'Job',
        type: 'push',
        pushToken: 'tok',
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 5,
        successThreshold: 3,
        reminderBackoff: 'exponential',
        maxReminders: 4,
        timeout: 48,
      },
    ],
    statusPages: [
      {
        id: 9,
        title: 'Status',
        slug: 'Acme',
        published: true,
        domains: ['status.example.com'],
        groups: [
          {
            name: 'Core',
            defaultOpen: false,
            monitors: [
              { monitor: 'm1', sendUrl: true, name: 'Website' },
              { monitor: 'm3' },
              { type: 'static', monitor: null, name: 'Support', description: 'Mon-Fri' },
            ],
          },
        ],
        incidents: [
          {
            title: 'Incident',
            style: 'danger',
            active: false,
            resolvedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
  }

  it('validates per document and remaps relationships by key', () => {
    const plan = parseMarmotExport(file)
    expect(plan.format).toBe('marmot')
    expect(plan.notifications.map((n) => n.name)).toEqual(['Hooks'])
    expect(plan.notifications[0].config).toMatchObject({
      url: 'https://example.com/hook',
      method: 'POST',
    })
    expect(plan.skipped.notifications).toEqual([
      { name: 'Nope', reason: expect.stringContaining('carrier-pigeon') },
    ])

    expect(plan.monitors.map((m) => m.data.name)).toEqual(['Group', 'Site', 'Orphan', 'Job'])
    expect(plan.skipped.monitors).toEqual([
      { name: 'Bad', reason: expect.stringMatching(/hostname|port/) },
    ])
    const site = plan.monitors.find((m) => m.data.name === 'Site')!
    expect(site.parentKey).toBe('g1')
    expect(site.notificationKeys).toEqual(['5'])
    expect(plan.monitors.find((m) => m.data.name === 'Orphan')!.parentKey).toBeNull()
    expect(plan.monitors.find((m) => m.data.name === 'Job')!.pushToken).toBe('tok')
    // Recovery threshold and reminder backoff (#147) round-trip; older files get the defaults.
    expect(plan.monitors.find((m) => m.data.name === 'Job')!.data).toMatchObject({
      successThreshold: 3,
      reminderBackoff: 'exponential',
      maxReminders: 4,
    })
    expect(site.data).toMatchObject({
      successThreshold: 1,
      reminderBackoff: 'none',
      maxReminders: 0,
    })

    expect(plan.statusPages).toHaveLength(1)
    const page = plan.statusPages[0]
    expect(page.data).toMatchObject({
      title: 'Status',
      slug: 'acme',
      published: true,
      theme: 'auto',
    })
    expect(page.domains).toEqual(['status.example.com'])
    expect(page.groups).toEqual([
      {
        name: 'Core',
        defaultOpen: false,
        monitors: [
          {
            monitorKey: 'm1',
            type: 'monitor',
            name: 'Website',
            description: null,
            showValues: true,
            sendUrl: true,
            customUrl: null,
          },
          {
            monitorKey: null,
            type: 'static',
            name: 'Support',
            description: 'Mon-Fri',
            showValues: true,
            sendUrl: false,
            customUrl: null,
          },
        ],
      },
    ])
    expect(page.incidents).toEqual([
      expect.objectContaining({ title: 'Incident', style: 'danger', active: false }),
    ])
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"Orphan": parent group #missing was not imported'),
        expect.stringContaining('1 monitor → notification link dropped'),
        expect.stringContaining('"Status": 1 monitor row dropped'),
      ]),
    )
  })

  it('drops tag and proxy references and skips docker monitors (organization resources)', () => {
    const base = { interval: 60, retryInterval: 60, maxRetries: 0, resendInterval: 0, timeout: 48 }
    const plan = parseMarmotExport({
      ...file,
      notifications: [],
      statusPages: [],
      monitors: [
        {
          ...base,
          id: 't1',
          name: 'Tagged',
          type: 'http',
          url: 'https://example.com',
          tags: [{ tag: 3, value: 'prod' }],
          proxy: 4,
        },
        {
          ...base,
          id: 'd1',
          name: 'Container',
          type: 'docker',
          dockerHost: 7,
          dockerContainer: 'app',
        },
      ],
    })
    expect(plan.monitors).toHaveLength(1)
    expect(plan.monitors[0].data).toMatchObject({ name: 'Tagged', tags: [], proxy: null })
    expect(plan.skipped.monitors).toEqual([
      { name: 'Container', reason: expect.stringContaining('Docker host') },
    ])
    expect(plan.warnings).toEqual([
      expect.stringContaining('"Tagged": tags and proxy not imported'),
    ])
  })

  it('keeps push schedules and defaults older exports to the interval schedule', () => {
    const base = { interval: 60, retryInterval: 60, maxRetries: 0, resendInterval: 0, timeout: 48 }
    const plan = parseMarmotExport({
      ...file,
      notifications: [],
      statusPages: [],
      monitors: [
        {
          ...base,
          id: 'c1',
          name: 'Nightly',
          type: 'push',
          pushToken: 'cron-token',
          pushSchedule: 'cron',
          pushCron: '0 2 * * *',
          pushTimezone: 'Europe/Berlin',
          pushGrace: 1800,
          pushMaxDuration: 3600,
        },
        { ...base, id: 'c2', name: 'Legacy', type: 'push', pushToken: 'old' },
        { ...base, id: 'c3', name: 'Broken', type: 'push', pushSchedule: 'cron', pushCron: 'x' },
      ],
    })
    expect(plan.monitors.map((m) => m.data.name)).toEqual(['Nightly', 'Legacy'])
    expect(plan.monitors[0].data).toMatchObject({
      pushSchedule: 'cron',
      pushCron: '0 2 * * *',
      pushTimezone: 'Europe/Berlin',
      pushGrace: 1800,
      pushMaxDuration: 3600,
    })
    expect(plan.monitors[0].pushToken).toBe('cron-token')
    expect(plan.monitors[1].data).toMatchObject({
      pushSchedule: 'interval',
      pushCron: null,
      pushTimezone: 'SAME_AS_SERVER',
      pushGrace: null,
      pushMaxDuration: null,
    })
    expect(plan.skipped.monitors).toEqual([
      { name: 'Broken', reason: expect.stringContaining('cron') },
    ])
  })
})
