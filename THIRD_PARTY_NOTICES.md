# Third-party notices

Marmot is licensed under the GNU AGPL v3 (see `LICENSE`). It draws on the following projects:

## Uptime Kuma — MIT License

Copyright (c) 2021 Louis Lam. https://github.com/louislam/uptime-kuma

Marmot's monitoring engine, monitor types, notification providers, status-page model and badge endpoints are
heavily inspired by Uptime Kuma, and some files are direct TypeScript ports. Ported files carry an
attribution comment and are listed here:

<!-- Keep this list current when porting a file. -->

- `src/server/stats/uptime-calculator.ts` — port of `server/uptime-calculator.js` (bucket keys, running
  averages, uptime/ping aggregation).
- `src/server/jobs/retention.ts` — based on `server/jobs/clear-old-data.js` and the pruning logic of
  `server/uptime-calculator.js`.
- `src/server/engine/beat.ts` — heartbeat state machine (`Monitor.beat`, `isImportantBeat`,
  `isImportantForNotification` from `server/model/monitor.js`)
- `src/server/monitor-types/http-request.ts` — HTTP request building and `checkStatusCode`
  (`server/model/monitor.js`, `server/util-server.js`)
- `src/server/monitor-types/http.ts`, `keyword.ts` — `http`/`keyword` branches of `server/model/monitor.js`
- `src/server/monitor-types/json-query.ts` — `evaluateJsonQuery` from `src/util.ts`
- `src/server/monitor-types/port.ts` — `server/monitor-types/tcp.js`
- `src/server/monitor-types/ping.ts` — `ping`/`pingAsync` from `server/util-server.js`
- `src/server/monitor-types/dns.ts` — `server/monitor-types/dns.js`
- `src/server/monitor-types/push.ts` — `push` branch of `server/model/monitor.js`
- `src/server/monitor-types/group.ts` — `server/monitor-types/group.js`
- `src/server/monitor-types/manual.ts` — `server/monitor-types/manual.js`
- `src/server/monitor-types/docker.ts`, `src/server/docker/client.ts` — `docker` branch of
  `server/model/monitor.js` and `DockerHost.testDockerHost` / `patchDockerURL` from `server/docker.js`
- `src/server/proxies/dispatcher.ts` — supported protocols and resolution semantics of `server/proxy.js`
- `src/server/monitor-types/sql.ts`, `mysql.ts`, `postgres.ts`, `sqlserver.ts` —
  `server/monitor-types/{mysql,postgres,mssql}.js`
- `src/server/monitor-types/redis.ts` — `server/monitor-types/redis.js`
- `src/server/monitor-types/mongodb.ts` — `server/monitor-types/mongodb.js`
- `src/server/monitor-types/mqtt.ts` — `server/monitor-types/mqtt.js`
- `src/server/monitor-types/kafka-producer.ts` — `kafkaProducerAsync` from `server/util-server.js` and the
  `kafka-producer` branch of `server/model/monitor.js`
- `src/server/monitor-types/grpc-keyword.ts` — `server/monitor-types/grpc.js`
- `src/server/monitor-types/websocket-upgrade.ts` — `server/monitor-types/websocket-upgrade.js`
- `src/server/monitor-types/smtp.ts` — `server/monitor-types/smtp.js`
- `src/server/monitor-types/snmp.ts` — `server/monitor-types/snmp.js`
- `src/server/monitor-types/ntp.ts` — `server/monitor-types/ntp.js`
- `src/server/monitor-types/sftp.ts` — `server/monitor-types/sftp.js`
- `src/server/monitor-types/rabbitmq.ts` — `server/monitor-types/rabbitmq.js`
- `src/server/monitor-types/radius.ts` — `server/radius-client.js` and `radius` from `server/util-server.js`
- `src/server/monitor-types/tailscale-ping.ts` — `server/monitor-types/tailscale-ping.js`
- `src/server/monitor-types/steam.ts` — `server/monitor-types/steam.js`
- `src/server/monitor-types/globalping.ts` — request shapes, the retry after a 500, API error and
  "out of credits" messages and the probe location format of `server/monitor-types/globalping.js`
- `src/server/monitor-types/gamedig.ts` — `server/monitor-types/gamedig.js`
- `src/server/monitor-types/real-browser.ts` — `server/monitor-types/real-browser-monitor-type.js`
- `src/server/notification-providers/http.ts` — error formatting and `extractAddress` from
  `server/notification-providers/notification-provider.js`
- `src/server/notifications/message.ts` — default message text from `Monitor.sendNotification`
  (`server/model/monitor.js`); the `monitorJSON` / `heartbeatJSON` template variable names and
  `heartbeatJSON.localDateTime` / `timezone` from `server/notification-providers/notification-provider.js`
- `src/lib/notification-template-variables.ts` — the Uptime Kuma 2.x template variable names
  (`monitorJSON`, `heartbeatJSON`) from `server/notification-providers/notification-provider.js`
- `src/server/notification-providers/discord.ts` — `server/notification-providers/discord.js`
- `src/server/notification-providers/slack.ts` — `server/notification-providers/slack.js`
- `src/server/notification-providers/telegram.ts` — `server/notification-providers/telegram.js`
- `src/server/notification-providers/teams.ts` — `server/notification-providers/teams.js`
- `src/server/notification-providers/ntfy.ts` — `server/notification-providers/ntfy.js`
- `src/server/notification-providers/gotify.ts` — `server/notification-providers/gotify.js`
- `src/server/notification-providers/pushover.ts` — `server/notification-providers/pushover.js`
- `src/server/notification-providers/matrix.ts` — `server/notification-providers/matrix.js`
- `src/server/notification-providers/webhook.ts` — `server/notification-providers/webhook.js`
- `src/server/notification-providers/smtp.ts` — `server/notification-providers/smtp.js`
- `src/server/status-pages/public.ts`, `src/server/status-pages/rss.ts` — public status page data,
  `overallStatus` / status descriptions and the RSS feed shape (`server/model/status_page.js`,
  `server/routers/status-page-router.js`)
- `src/server/notification-providers/mattermost.ts` — `server/notification-providers/mattermost.js`
- `src/server/notification-providers/rocket-chat.ts` — `server/notification-providers/rocket-chat.js`
- `src/server/notification-providers/google-chat.ts` — `server/notification-providers/google-chat.js`
- `src/server/notification-providers/pagerduty.ts` — `server/notification-providers/pagerduty.js`
- `src/server/notification-providers/opsgenie.ts` — `server/notification-providers/opsgenie.js`
- `src/server/notification-providers/apprise.ts` — `server/notification-providers/apprise.js`
- `src/server/notification-providers/signal.ts` — `server/notification-providers/signal.js`
- `src/server/notification-providers/home-assistant.ts` — `server/notification-providers/home-assistant.js`
- `src/server/notification-providers/pushbullet.ts` — `server/notification-providers/pushbullet.js`
- `src/server/notification-providers/twilio.ts` — `server/notification-providers/twilio.js`
- `src/server/notification-providers/sendgrid.ts` — `server/notification-providers/send-grid.js`
- `src/server/notification-providers/resend.ts` — `server/notification-providers/resend.js`
- `src/server/notification-providers/bark.ts` — `server/notification-providers/bark.js`
- `src/server/notification-providers/pushdeer.ts` — `server/notification-providers/pushdeer.js`
- `src/server/notification-providers/serverchan.ts` — `server/notification-providers/serverchan.js`
- `src/server/notification-providers/splunk.ts` — `server/notification-providers/splunk.js`
- `src/server/notification-providers/squadcast.ts` — `server/notification-providers/squadcast.js`
- `src/server/notification-providers/webpush.ts` — `server/notification-providers/Webpush.js`
- `src/server/notification-providers/line-messaging.ts` — `server/notification-providers/line.js`
- `src/server/notification-providers/pumble.ts` — `server/notification-providers/pumble.js`
- `src/server/notification-providers/zoho-cliq.ts` — `server/notification-providers/zoho-cliq.js`
- `src/server/notification-providers/clicksend.ts` — `server/notification-providers/clicksendsms.js`
- `src/server/notification-providers/alerta.ts` — `server/notification-providers/alerta.js`
- `src/server/notification-providers/grafana-oncall.ts` — `server/notification-providers/grafana-oncall.js`
- `src/server/notification-providers/heii-oncall.ts` — `server/notification-providers/heii-oncall.js`
- `src/server/notification-providers/nextcloud-talk.ts` — `server/notification-providers/nextcloudtalk.js`
- `src/server/notification-providers/techulus-push.ts` — `server/notification-providers/techulus-push.js`
- `src/server/notification-providers/pushy.ts` — `server/notification-providers/pushy.js`
- `src/server/notification-providers/onebot.ts` — `server/notification-providers/onebot.js`
- `src/server/notification-providers/wecom.ts` — `server/notification-providers/wecom.js`
- `src/server/notification-providers/dingding.ts` — `server/notification-providers/dingding.js`
- `src/server/notification-providers/feishu.ts` — `server/notification-providers/feishu.js`
- `src/server/notification-providers/bitrix24.ts` — `server/notification-providers/bitrix24.js`
- `src/server/maintenance/status.ts` — maintenance status and window computation (`getStatus`,
  `generateCron`, `calcDuration`, `getRunningTimeslot`, `inferDuration` from `server/model/maintenance.js`)
- `src/server/maintenance/resolver.ts` — `Monitor.isUnderMaintenance` (parent-group walk) from
  `server/model/monitor.js`
- `src/server/maintenance/status-page.ts` — `StatusPage.getMaintenanceList` from `server/model/status_page.js`
- `src/lib/validation/maintenance.ts`, `src/components/maintenance/maintenance-form.tsx` — form semantics
  and defaults of `src/pages/EditMaintenance.vue`
- `src/server/engine/tls.ts` — `checkCertificate`, `parseCertificateInfo`, `checkCertificateHostname` from
  `server/util-server.js`
- `src/server/jobs/cert-expiry.ts` — `checkCertExpiryNotifications` (`server/util-server.js`) and
  `sendCertNotificationByTargetDays` / `updateTlsInfo` (`server/model/monitor.js`)
- `src/server/jobs/domain-expiry.ts`, `src/server/jobs/expiry-history.ts` — `server/model/domain_expiry.js`
  and the `notification_sent_history` table
- `src/auth/two-factor/totp.ts`, `src/auth/two-factor/handlers.ts` — two-factor login flow (`login`,
  `prepare2FA`, `save2FA`, `disable2FA`, `verifyToken` handlers in `server/server.js`: one-step TOTP
  window and last-token replay check)
- `src/server/import-export/uptime-kuma.ts`, `src/server/import-export/kuma-notifications.ts` — backup
  JSON format and import semantics of the `uploadBackup` handler (`server/server.js`,
  `src/components/settings/Backup.vue` in Uptime Kuma 1.23), monitor field names from
  `Monitor.toJSON()` (`server/model/monitor.js`) and notification config keys from
  `server/notification-providers/*.js`
- `src/server/badges/badge.ts` — badge handlers of `server/routers/api-router.js`, `badgeConstants`
  (`src/util.ts`), `percentageToColor` / `filterAndJoin` (`server/util-server.js`)
- `src/server/push/index.ts`, `recordExternalBeat` in `src/server/engine/worker.ts` — `/api/push/:pushToken`
  handler of `server/routers/api-router.js`
- `src/server/metrics/prometheus.ts` — metric names, help texts and labels from `server/prometheus.js`
- `src/collections/ApiKeys.ts`, `src/server/api-keys/index.ts` — modelled on `server/model/api_key.js` and
  `apiAuth` in `server/auth.js`

The MIT license text is reproduced below.

```
MIT License

Copyright (c) 2021 Louis Lam

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## kan.bn — AGPL-3.0

Copyright (c) kan.bn contributors. https://github.com/kanbn/kan

Marmot's workspace/organization model, membership roles, invitation flows, settings layout and permission
string conventions are inspired by kan.bn. Any code copied from kan.bn remains under the AGPL-3.0, the same
license as Marmot.

## Payload CMS — MIT License

The project scaffold originates from the official Payload `blank` template (MIT). The bundled Claude skill
under `.claude/skills/payload` is Payload's official agent skill (MIT), synced from
[payloadcms/skills](https://github.com/payloadcms/skills/tree/main/skills/payload) at `ae74c65` and
reformatted with Prettier; the upstream `README.md` is omitted.
