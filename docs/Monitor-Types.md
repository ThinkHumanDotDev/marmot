# Monitor types

Every monitor type is one file in `src/server/monitor-types/`, registered in that directory's `index.ts`
and described for the form in `src/lib/validation/monitor.ts` (`MONITOR_TYPE_GROUPS`, per-type required
fields). The worker runs the type's `check()` bounded by the monitor's `timeout` (0 = 80% of the
interval) and feeds the result through the heartbeat state machine ([Architecture](Architecture.md)).

Heavy client libraries are **optional dependencies** (`package.json` → `optionalDependencies`). They are
imported lazily inside `check()`, so the worker starts without them; a monitor whose driver is missing
goes DOWN with the message `The "<pkg>" package is not installed. Install <pkg> to use the <type> monitor`.
The Docker image installs all of them. Shared fields (`interval`, `retryInterval`, `maxRetries`,
`resendInterval`, `timeout`, `upsideDown`, `active`, `parent`, `description`) apply to every type and are
not repeated below. `degradedAfter` (ms, [Monitors → Degraded](Monitors.md#degraded)) applies to HTTP(s),
keyword, JSON query, TCP port, ping, DNS, gRPC and Globalping monitors.

| Type                | Label                                      | Fields                                                                                                                                                                                                                                                                                                           | Driver / requirement                 |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `http`              | HTTP(s)                                    | `url`, `method`, `httpBodyEncoding`, `body`, `headers`, `acceptedStatusCodes`, `maxRedirects`, `ignoreTls`, `expiryNotification`, `authMethod` + credentials, `assertions`                                                                                                                                       | — (undici)                           |
| `keyword`           | HTTP(s) - Keyword                          | HTTP fields + `keyword`, `invertKeyword`                                                                                                                                                                                                                                                                         | —                                    |
| `json-query`        | HTTP(s) - Json Query                       | HTTP fields + `jsonPath`, `jsonPathOperator`, `expectedValue`                                                                                                                                                                                                                                                    | — (jsonata)                          |
| `prometheus`        | Prometheus Query                           | `url` (API base URL), `prometheusQuery`, `prometheusDownOperator` + `prometheusDownThreshold`, optional degraded condition, `prometheusAggregate`, `prometheusNoDataStatus`, `prometheusErrorStatus`, `headers`, `proxy`, `ignoreTls`, `authMethod` none/basic/bearer; see [Prometheus query](#prometheus-query) | Prometheus HTTP API                  |
| `real-browser`      | HTTP(s) - Browser Engine (Chrome/Chromium) | `url`, `remoteBrowser` (ws:// URL of a Playwright-compatible browser server), `ignoreTls`                                                                                                                                                                                                                        | `playwright-core` + a remote browser |
| `browser-script`    | Browser Script (Playwright)                | `browserScript` (a Playwright script), `remoteBrowser`, optional `url` (start URL), `browserVariables`, `browserSecrets`, `browserArtifacts` failure \| always, `ignoreTls`; see [Browser scripts](#browser-scripts)                                                                                             | `playwright-core` + a remote browser |
| `port`              | TCP Port                                   | `hostname`, `port`                                                                                                                                                                                                                                                                                               | —                                    |
| `ping`              | Ping                                       | `hostname`                                                                                                                                                                                                                                                                                                       | system `ping` binary                 |
| `dns`               | DNS                                        | `hostname`, `port` (53), `dnsResolveServer`, `dnsResolveType`, `assertions` (dnsRecord)                                                                                                                                                                                                                          | —                                    |
| `globalping`        | Globalping                                 | `globalpingMeasurement` ping \| http \| dns \| traceroute, `url` or `hostname`, `globalpingLocations`, `globalpingProbes`, `globalpingSuccessRule`; see [Globalping](#globalping)                                                                                                                                | Globalping API                       |
| `status-page`       | Third-party status page                    | `url` (the vendor's status page), `statusPageProvider` auto \| atlassian \| instatus \| betterstack \| incidentio \| feed, `statusPageComponents` (`[{ id, name }]`); see [Third-party status pages](#third-party-status-pages)                                                                                  | — (fetch)                            |
| `push`              | Push                                       | `pushToken` (generated), `pushSchedule` interval \| cron, `pushCron`, `pushTimezone`, `pushGrace`, `pushMaxDuration`; the client calls `/api/push/<token>[/start\|/fail\|/log\|/<code>]` (see below)                                                                                                             | —                                    |
| `manual`            | Manual                                     | `manualStatus`                                                                                                                                                                                                                                                                                                   | —                                    |
| `group`             | Group                                      | children via `parent`                                                                                                                                                                                                                                                                                            | —                                    |
| `grpc-keyword`      | gRPC(s) - Keyword                          | `grpcUrl`, `grpcProtobuf`, `grpcServiceName`, `grpcMethod`, `grpcEnableTls`, `grpcBody`, `grpcMetadata`, `keyword`, `invertKeyword`                                                                                                                                                                              | `@grpc/grpc-js`, `protobufjs`        |
| `websocket-upgrade` | WebSocket Upgrade                          | `url` (ws:// or wss://), `acceptedStatusCodes` (close codes, default `1000`), `headers`, `wsSubprotocol`, `wsIgnoreSecWebsocketAcceptHeader`, `ignoreTls`, `authMethod` basic/bearer/mTLS                                                                                                                        | `ws`                                 |
| `mqtt`              | MQTT                                       | `hostname` (scheme optional: mqtt, mqtts, ws, wss), `port` (1883), `mqttTopic`, `mqttUsername`, `mqttPassword`, `mqttCheckType` keyword \| json-query, `mqttSuccessMessage`, `jsonPath`, `expectedValue`                                                                                                         | `mqtt`                               |
| `kafka-producer`    | Kafka Producer                             | `kafkaProducerBrokers`, `kafkaProducerTopic`, `kafkaProducerMessage`, `kafkaProducerSsl`, `kafkaProducerAllowAutoTopicCreation`, `kafkaProducerSaslOptions` (JSON)                                                                                                                                               | `kafkajs`                            |
| `rabbitmq`          | RabbitMQ                                   | `rabbitmqNodes` (management API URLs), `rabbitmqUsername`, `rabbitmqPassword`                                                                                                                                                                                                                                    | — (fetch)                            |
| `smtp`              | SMTP                                       | `hostname`, `port` (25), `smtpSecurity` opportunistic \| starttls \| secure \| nostarttls, `ignoreTls`                                                                                                                                                                                                           | — (nodemailer)                       |
| `snmp`              | SNMP                                       | `hostname`, `port` (161), `snmpOid`, `snmpVersion` 1 \| 2c, `snmpCommunity`, optional `jsonPath`, `jsonPathOperator`, `expectedValue`                                                                                                                                                                            | `net-snmp`                           |
| `ntp`               | NTP                                        | `hostname`, `port` (123); fails on stratum ≥ 5 or 16, \|offset\| ≥ 1000 ms, dispersion ≥ 500 ms                                                                                                                                                                                                                  | —                                    |
| `sftp`              | SFTP                                       | `hostname`, `port` (22), `sshUsername`, `sshAuthMethod` password \| privateKey, `sshPassword`, `sshPrivateKey`, `sshPassphrase`, `sftpPath`                                                                                                                                                                      | `ssh2-sftp-client`                   |
| `ssh`               | SSH                                        | `hostname`, `port` (22); optional `sshUsername` + `sshAuthMethod` password \| privateKey, `sshPassword`, `sshPrivateKey`, `sshPassphrase`; optional `sshCommand`, `sshExpectedExitCode` (0), `sshExpectedOutput`; see [Protocol checks](#protocol-checks)                                                        | `ssh2` (only to log in)              |
| `udp`               | UDP                                        | `hostname`, `port` (required), `udpPayload`, `udpPayloadEncoding` text \| hex, `udpResponseMatch` none \| any \| keyword \| regex, `udpResponsePattern`                                                                                                                                                          | — (dgram)                            |
| `tls`               | TLS Handshake                              | `hostname`, `port` (443), `tlsServername` (SNI), `tlsAlpn`, `ignoreTls`, `expiryNotification`                                                                                                                                                                                                                    | —                                    |
| `imap`              | IMAP                                       | `hostname`, `port` (143, 993 with implicit TLS), `smtpSecurity`, `mailUsername`, `mailPassword`, `ignoreTls`, `expiryNotification`                                                                                                                                                                               | —                                    |
| `pop3`              | POP3                                       | `hostname`, `port` (110, 995 with implicit TLS), `smtpSecurity`, `mailUsername`, `mailPassword`, `ignoreTls`, `expiryNotification`                                                                                                                                                                               | —                                    |
| `radius`            | Radius                                     | `hostname`, `port` (1812), `radiusUsername`, `radiusPassword`, `radiusSecret`, `radiusCalledStationId`, `radiusCallingStationId`                                                                                                                                                                                 | `radius`                             |
| `tailscale-ping`    | Tailscale Ping                             | `hostname`                                                                                                                                                                                                                                                                                                       | `tailscale` CLI on the worker host   |
| `mysql`             | MySQL/MariaDB                              | `databaseConnectionString` (`mysql://…`), `databaseQuery` (default `SELECT 1`)                                                                                                                                                                                                                                   | `mysql2`                             |
| `postgres`          | PostgreSQL                                 | `databaseConnectionString` (`postgres://…`), `databaseQuery` (default `SELECT 1`)                                                                                                                                                                                                                                | `pg`                                 |
| `sqlserver`         | Microsoft SQL Server                       | `databaseConnectionString` (`Server=…;Database=…;User Id=…;Password=…`), `databaseQuery` (default `SELECT 1`)                                                                                                                                                                                                    | `mssql`                              |
| `mongodb`           | MongoDB                                    | `databaseConnectionString` (`mongodb://…`), `databaseQuery` (JSON command, default `{"ping": 1}`), optional `jsonPath`, `expectedValue`                                                                                                                                                                          | `mongodb`                            |
| `redis`             | Redis                                      | `databaseConnectionString` (`redis://…` or `rediss://…`), `ignoreTls`                                                                                                                                                                                                                                            | — (ioredis)                          |
| `steam`             | Steam Game Server                          | `hostname`, `port`; `steamApiKey` instance setting                                                                                                                                                                                                                                                               | Steam Web API key                    |
| `gamedig`           | GameDig                                    | `hostname`, `port`, `game` (GameDig id), `gamedigGivenPortOnly`                                                                                                                                                                                                                                                  | `gamedig`                            |

## Protocol checks

The SSH, UDP, TLS handshake, IMAP and POP3 types (#141) connect from the worker through the outbound
address guard, like the TCP port type.

- **`ssh`** reads the server's identification line (`SSH-2.0-OpenSSH_9.6`, the heartbeat message).
  Without `sshUsername` that is the whole check. With it the monitor logs in (password or private key,
  the same fields as SFTP); a rejected login is DOWN with `Authentication failed for <user>`. With
  `sshCommand` it then runs the command and requires the exit code `sshExpectedExitCode` (default 0)
  and, when set, `sshExpectedOutput` in its standard output (the first 64 KB are kept). The host key is
  not pinned.
- **`udp`** sends one datagram (`udpPayload`, UTF-8 text or hex pairs such as `ff 00 1a`; may be empty)
  from a connected socket. With `udpResponseMatch` `none` the check listens for up to 2 seconds (or the
  timeout, if shorter): an ICMP port unreachable is DOWN, silence or any reply is UP. `any`, `keyword`
  (the reply contains `udpResponsePattern`) and `regex` (it matches) wait up to the monitor timeout for a
  reply; no reply is DOWN. The response time is the round trip of the reply.
- **`tls`** completes a TLS handshake with `tlsServername` as SNI (default: the hostname unless it is an
  IP) and offers the comma-separated `tlsAlpn` protocols; when ALPN protocols are offered the server
  must select one. The message names the TLS version, the negotiated protocol and the certificate's
  remaining days; the request timing records DNS, connect and TLS phases.
- **`imap`** and **`pop3`** read the greeting (`* OK` / `+OK`), secure the session according to
  `smtpSecurity` (shared with SMTP): `opportunistic` upgrades with STARTTLS (IMAP) or STLS (POP3) when
  the server offers it, `starttls` requires it, `secure` connects with implicit TLS (ports 993 / 995) and
  `nostarttls` stays in plain text. With `mailUsername` they log in (IMAP `LOGIN`, POP3 `USER`/`PASS`) and
  then log out. Credentials are only ever sent over TLS, unless `nostarttls` was chosen explicitly.
- **Certificates**: `tls`, `imap` and `pop3` record the certificate of every TLS connection in
  `monitors.certInfo`, shown in the certificate panel of the monitor page, whether the check is UP or
  DOWN. An untrusted chain or a certificate that does not cover the name is DOWN
  (`TLS certificate is not trusted: …`) unless `ignoreTls` is on. With `expiryNotification` they send the
  same expiry warnings as HTTPS monitors (`tlsExpiryNotifyDays`, skipped with `ignoreTls`), naming the
  monitor by `host:port`.

## Globalping

`globalping` monitors run the check from [Globalping](https://globalping.io) community probes instead of
the worker: a cheap way to see a service from many places before Marmot has probes of its own (#91, #92).

- **Measurement**: `ping` (`globalpingPackets` packets, ICMP or TCP to `port`), `http` (`url` with
  `method` HEAD, GET or OPTIONS, `headers`, `acceptedStatusCodes`; an untrusted certificate fails unless
  `ignoreTls`), `dns` (`dnsResolveType`, optional `dnsResolveServer` and `port`; at least one answer) or
  `traceroute` (the last hop must answer from the target's address). `globalpingProtocol` and
  `globalpingIpVersion` are passed through; empty means the API default.
- **Locations**: `globalpingLocations` is a comma-separated list in Globalping's location syntax
  (`Europe`, `US+AWS`, `AS13335`, `Frankfurt`; empty = anywhere), and `globalpingProbes` (1–50) probes
  answer per check.
- **Status rule**: `globalpingSuccessRule` `all` (default), `any`, or `atLeast` with
  `globalpingMinSuccess`. The heartbeat message lists each probe (`Frankfurt, DE, EU, Hetzner (AS24940):
200 OK, 23 ms`), `heartbeats.probes` stores `{ location, ok, latency, msg }` per probe, and the beat's
  response time is the average latency of the successful probes (so `degradedAfter` applies to it).
- **Credentials and limits**: the `globalpingApiToken` instance setting is sent as a bearer token when set;
  otherwise checks are anonymous (250 probe measurements per hour per IP). Every probe uses one credit, so
  `interval` and `retryInterval` are at least 60 s for this type.
- **Rate limits never mark a monitor DOWN**: a `429` records a PENDING beat that says so and when checks
  resume; it uses up no retry, sends no notification, does not count as downtime and keeps the monitor's
  previous state (like the "checker offline" beats of the [self connectivity check](Monitors.md)). The
  worker then skips the API for those credentials until the reset time the API announced
  (`Retry-After` / `X-RateLimit-Reset`, at most an hour). An unavailable API (5xx after one retry,
  network errors) is held the same way; validation errors (bad target, no probe in the locations) are
  DOWN with the API's message.
- The private-address guard does not apply: the worker only talks to `api.globalping.io`, and Globalping
  itself refuses private targets.

## Third-party status pages

`status-page` monitors follow a vendor's hosted status page (#125), so a cloud provider, payment processor
or email API shows up on the dashboard, on your status pages and in your alerts when the vendor reports an
incident.

- **Formats** (`statusPageProvider`, `auto` by default tries them in this order and remembers the one that
  answered): Atlassian Statuspage (`/api/v2/summary.json`; also incident.io pages that serve it and Marmot's
  own status pages, `/status/<slug>`), Instatus (`/summary.json` + `/v2/components.json`), Better Stack
  (`/index.json`), incident.io (`/proxy/<host>`), and an RSS / Atom fallback (a feed URL, the feed the page
  advertises with `<link rel="alternate">`, or `/history.rss` / `/history.atom` / `/feed.rss`). Paste the
  page (`https://www.githubstatus.com`) or one of these documents.
- **Status**: the vendor's indicator `none` → UP, `minor` (degraded performance, partial outage) →
  DEGRADED, `major` / `critical` (major outage) → DOWN, maintenance in progress → MAINTENANCE. DOWN goes
  through `maxRetries` like any failed check. The heartbeat message names the vendor's current incident and
  its link, e.g. `Actions · Major outage: Disruption with some GitHub Actions workflows (https://stspg.io/…)`.
- **Component filter**: `statusPageComponents` stores the vendor's component **ids**; the name is only a
  label, so a component the vendor renames keeps matching. The form's **Load components** button reads the
  page once (`POST /api/orgs/:orgId/status-page-components`, same budget as "Check now") and lets you pick.
  With a filter, the status is the worst of the picked components and of the incidents naming them. An id
  the vendor no longer lists is reported in the heartbeat message (`component no longer on the status page:
Webhooks (abc123)`) instead of silently reading as up; when every picked id is gone the check is DOWN.
  RSS / Atom feeds have no components, so the filter does not apply to them: the newest entry counts as an
  open incident (DEGRADED, or MAINTENANCE when its title says so) while it is less than 24 hours old and
  does not say resolved or completed.
- **Interval**: checks run every `interval`, but never more often than every 120 seconds, and never inside
  the vendor document's cache lifetime (`Cache-Control: max-age`, else `Expires` − `Date`, capped at an
  hour): polling inside that window just re-reads the same document. The lifetime of the last response is
  kept in `monitors.status.cacheSeconds`.
- **On status pages** the monitor reads like a static component: its state written out ("Major outage",
  "Degraded performance", "Operational") instead of a beat bar.
- The private-address guard applies to the URL and every redirect. The type is not available on probe
  locations.

## Prometheus query

`prometheus` monitors (#140) turn a signal you already have in Prometheus (an error rate, a queue
depth, a replica count) into a monitor status, so it drives status pages, incidents and alerts like
any other check.

- **Endpoint**: `url` is the base URL of a Prometheus-compatible HTTP API: Prometheus
  (`http://prometheus:9090`), Thanos Query, Mimir or Grafana Cloud (`…/prometheus`), VictoriaMetrics
  (`http://victoria:8428`). Marmot appends `/api/v1/query` (unless the URL already ends with it) and sends
  the query as an instant query (`GET …/api/v1/query?query=…`). Authentication is none, basic or bearer;
  `headers` adds others (`X-Scope-OrgID` for multi-tenant Mimir), `proxy` and `ignoreTls` work as for
  HTTP monitors, and the [outbound address guard](Security.md) applies.
- **Conditions**: the monitor is **DOWN** when the value meets `prometheusDownOperator`
  `prometheusDownThreshold` (`>`, `>=`, `<`, `<=`, `==`, `!=`), else **DEGRADED** when it meets the
  optional degraded condition, else **UP**. `NaN` (for example a ratio without traffic) meets no
  condition. Example, DOWN above a 5 % error rate and degraded above 1 %:

  ```promql
  sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
  ```

  with DOWN `> 0.05` and degraded `> 0.01`. Retries, the recovery threshold and upside-down mode apply
  as usual.

- **Several series** (`prometheusAggregate`): every series is judged on its own. `worst` (default) takes
  the worst status and reports the most extreme value among those series; `any` takes the same status
  and reports the first series (in result order) that reached it; `all` applies a status only when every
  series reaches it, so one healthy series keeps the monitor UP. Scalars count as one series without
  labels; a range selector (matrix) uses the latest sample of each series.
- **No data and errors**: an empty result takes `prometheusNoDataStatus`; a failed query (HTTP error,
  `status: "error"` from Prometheus, an answer that is not the query API's, an unreachable endpoint)
  takes `prometheusErrorStatus`. Each is `up`, `down` (default) or `pending`, which holds the monitor's
  current status like a deferred check: a PENDING beat that uses no retry and sends no notification. A
  target refused by the outbound guard and the check timeout are always DOWN.
- **Value**: the judged value is stored on the heartbeat (`heartbeats.value`), shown in the message
  (`queue_depth{queue="b"} = 250 (3 series) meets the DOWN condition > 100`) and rolled up per bucket
  (`extras.value` = average, minimum, maximum and count). The monitor page charts it over the selected
  period instead of the response time, and reports the average value instead of a latency percentile.
  The response time of the query itself still feeds the uptime statistics.

## Browser scripts

`browser-script` monitors (#139) _(landing in the current release)_ run a user journey (sign up, log in,
check out, search) in a real browser on every check, against the same remote browser the
`real-browser` monitor uses (`remoteBrowser`, a Playwright-compatible `ws://` server such as
[browserless](https://www.browserless.io/) or `npx playwright run-server`). The check is UP when the
script finishes and DOWN at the first error or failed expectation, with that message.

```js
await test.step('log in', async () => {
  await page.goto('/login') // relative to the monitor's start URL
  await page.getByLabel('Email').fill(vars.email)
  await page.getByLabel('Password').fill(secrets.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
})
await test.step('see the dashboard', async () => {
  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByText('Welcome')).toBeVisible()
})
```

- **API**: the script is the body of an async function with a subset of Playwright's test API:
  - `page`: `goto`, `reload`, `goBack`, `goForward`, `waitForURL`, `waitForLoadState`, `waitForTimeout`,
    `waitForSelector`, `title`, `url`, `content`, `setViewportSize`, `evaluate`, `keyboard.*`, `mouse.*`,
    and the selector shortcuts (`click`, `fill`, …).
  - Locators: `locator`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`,
    `getByTitle`, `getByTestId`, `frameLocator`, `filter`, `first`, `last`, `nth`, `and`, `or`. Actions
    and queries: `click`, `fill`, `press`, `check`, `selectOption`, `hover`, `textContent`, `inputValue`,
    `isVisible`, `count`, `all`, `evaluate`, ….
  - `expect(locator)`: `toBeVisible`, `toBeHidden`, `toBeAttached`, `toBeEnabled`, `toBeDisabled`,
    `toBeChecked`, `toBeEditable`, `toBeFocused`, `toHaveText`, `toContainText`, `toHaveValue`,
    `toHaveAttribute`, `toHaveClass`, `toHaveCount`; `expect(page)`: `toHaveURL`, `toHaveTitle`; values:
    `toBe`, `toEqual`, `toContain`, `toMatch`, `toBeTruthy`, comparisons, `toHaveLength`, …; all with
    `.not`. Locator and page expectations retry until their `timeout` (default 5 s).
  - `test.step(name, fn)` for per-step timing, `vars.<name>` and `secrets.<name>` from the monitor,
    `url` (the start URL) and `console.log` (shown with the result).
  - Anything else (`page.screenshot({ path })`, `setInputFiles`, `page.route`, `page.request`,
    `page.context()`, `require`, `import`, `process`, `fetch`, timers) does not exist in the script.
    `page.evaluate()` runs in the browser page, so pages can still use their own `fetch`.
- **Sandbox**: the script never runs in the worker's JavaScript engine (no `eval`, `new Function` or
  `node:vm`). Each check starts a worker thread with a fresh
  [QuickJS](https://github.com/justjake/quickjs-emscripten) engine compiled to WebAssembly: its own heap
  and globals, no Node objects and no module loader, so `globalThis.constructor.constructor`, `eval` and
  `import()` only reach QuickJS itself. The only way out is a JSON bridge whose host side allow-lists the
  operations above: the script cannot read files or environment variables, reach Payload or Redis, or open
  connections except through the browser.
- **Limits**: the script's heap is capped at 32 MB, it may not run for more than 1 s without awaiting the
  browser (or 5 s of CPU in total), and the run stops at the monitor's `timeout` (a quarter of it, at most
  5 s, is kept to capture the artifacts): the thread is terminated, whatever the script is doing.
  `timeout` defaults to 48 s; raise it (and the interval) for long journeys.
- **Network**: while `MONITOR_DENY_PRIVATE_ADDRESSES` is on, browser scripts are refused like the Browser
  Engine monitor (the browser resolves names itself). With `MONITOR_DENY_CIDRS` only, every request and
  WebSocket of the page (navigations, redirects, subresources, `fetch`) is vetted by the
  [outbound address guard](Configuration.md#private-address-guard); refused ones are aborted and listed
  as failed requests. Only `http(s)` pages can be opened; service workers and downloads are off.
- **Artifacts**: on failure (or on every check with `browserArtifacts: always`) the check stores a JPEG
  screenshot and a Playwright trace (`.zip`, open it with `npx playwright show-trace` or at
  [trace.playwright.dev](https://trace.playwright.dev)) in the `check-artifacts` upload collection, next to
  the `media` uploads (`UPLOADS_DIR/check-artifacts`, or the S3 bucket). Only members of the organization
  can read them; they are linked from the heartbeat and deleted after `KEEP_DATA_PERIOD_DAYS` (the
  important-event retention) or with the monitor. Every check also records console errors, failed
  requests (network errors and HTTP ≥ 400), the steps with their timing, the script's output and the Web
  Vitals of the last page (TTFB, FCP, LCP, CLS, DOMContentLoaded, load) in `heartbeats.browser`; the
  monitor page shows the latest check and the Logs tab every check.
- **Secrets**: `browserSecrets` values are replaced by `[redacted]` in messages, steps, logs and request
  URLs, and the whole list is redacted in the audit log. Screenshots and traces show the page as the
  browser saw it, including values typed into fields: use dedicated test accounts.
- **Run now**: the editor's _Run now_ (like the form's _Test_) runs the unsaved script once on the worker
  and shows the steps, errors and screenshot inline without storing anything; _Check now_ on a saved
  monitor records a heartbeat with its screenshot and trace.
- Browser scripts run on the server's workers only, not on [probe locations](Probe-Locations.md).

## Assertions

HTTP-family monitors (`http`, `keyword`, `json-query`) and `dns` monitors take a list of **assertions**
(`monitors.assertions`, at most 10 per kind). The worker evaluates them after the request or lookup; the
check is UP only when **all** pass. Each row is `{ kind, target, comparator, value }`:

| Kind        | Target                                                                     | Comparators                                                                                |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `status`    | —                                                                          | `eq`, `not_eq`, `gt`, `gte`, `lt`, `lte`                                                   |
| `header`    | header name (case-insensitive)                                             | `eq`, `not_eq`, `contains`, `not_contains`, `empty`, `not_empty`, `matches`, `not_matches` |
| `textBody`  | — (the raw body)                                                           | same as `header`                                                                           |
| `jsonBody`  | JSONata expression (`data.count`, `$.status`)                              | same as `header`, plus `gt`, `gte`, `lt`, `lte`                                            |
| `dnsRecord` | record type (`A`, `MX`, `TXT`, …; default: the monitor's `dnsResolveType`) | `eq`, `not_eq`, `contains`, `not_contains`, `matches`, `not_matches`                       |

- **Comparisons** are on strings and case-sensitive; `gt`/`gte`/`lt`/`lte` compare numbers and fail when
  either side is not a number. `status` and `jsonBody` `eq` also accept numerically equal values
  (`3.0` = `3`). A missing header or an expression that matches nothing is _absent_: `empty`, `not_eq`,
  `not_contains` and `not_matches` pass, everything else fails. Repeated headers are joined with `, `.
- **JSON**: the body is parsed as JSON (a non-JSON body is queried as a string, like `json-query`), the
  expression is evaluated with [JSONata](https://jsonata.org) — JSONPath-style paths such as `$.data[0].id`
  work as they are — and objects/arrays are compared as their JSON text (`[]` and `{}` count as empty).
- **DNS**: records are compared as text: A/AAAA/NS/PTR/CNAME as returned, TXT chunks joined, MX → the
  exchange host, SRV → `priority weight port target`, CAA → `tag value`, SOA → its seven fields. Names
  compare case-insensitively without the trailing dot. `eq`, `contains` and `matches` pass when **any**
  record matches; `not_eq`, `not_contains` and `not_matches` pass when **none** does. Record types other
  than `dnsResolveType` are looked up with the same resolvers; "no such record" is an empty set.
- **Regular expressions** (`matches`) are `pattern` or `/pattern/flags` (flags `i`, `m`, `s`, `u`), at
  most 500 characters. Each match runs in a `node:vm` context with a 100 ms CPU budget (capped at 1 s of wall-clock
  time on a busy host), so a pattern with catastrophic backtracking fails the assertion instead of
  stalling the worker. Regexes inside JSONata
  expressions use the same guard, and every JSONata evaluation has a 1 s and 500-level depth budget. Nothing
  evaluates JavaScript.
- **Existing fields keep working and are shown as equivalent assertions.** Monitors are not migrated:
  `acceptedStatusCodes` is the `status` check unless the monitor has `status` assertions, which then
  replace it (so `status eq 404` works without editing the ranges). The keyword (`keyword`,
  `invertKeyword`) and JSON query (`jsonPath`, `jsonPathOperator`, `expectedValue`) conditions run as
  before, with their messages unchanged, and are reported as `textBody` / `jsonBody` results marked
  _monitor setting_.
- **Messages**: a failing check is DOWN with the first failing assertion, e.g.
  `header content-type: expected contains "json", got "text/html"` (status and type checks come first,
  then the assertions in order). A passing check appends `, N assertions passed` to the usual message.
  A failing assertion is always DOWN (with retries); a check whose assertions all pass but that answers
  slower than `degradedAfter` is DEGRADED like any other slow success.
- **Results**: every assertion is evaluated on every check. The results are stored on the heartbeat
  (`heartbeats.assertions`: `kind`, `target`, `comparator`, `expected`, `actual` (≤ 500 characters),
  `passed`, `error`, `legacy`) and the monitor page shows those of the last check. `runCheck()` returns
  them as `CheckResult.assertions`.
- **Import/export**: Marmot exports carry `assertions`; Uptime Kuma imports have none (Kuma's condition
  builder is not mapped).

The evaluator is `src/server/monitor-types/assertions.ts` (pure, table-driven tests next to it); the rules
shared by the form, the API and the collection are in `src/lib/validation/assertions.ts`.

## Notes

- **Credentials** (connection strings, passwords, keys, secrets) are stored with the monitor document.
  Use dedicated read-only accounts.
- **Timeouts**: the engine aborts any check at `timeout` seconds. Types pass the same budget to their
  driver (connect/query timeouts) so the heartbeat message names the real cause when possible.
- **`real-browser`** never launches Chromium itself. Run a browser server next to the worker (for
  example [browserless](https://www.browserless.io/) or `npx playwright run-server --port 3000`) and set
  its `ws://` URL in `remoteBrowser`. Screenshots are not stored.
- **Private-address guard** (`MONITOR_DENY_PRIVATE_ADDRESSES`, see
  [Configuration](Configuration.md#private-address-guard)): every type resolves its target and checks
  all addresses before connecting. `tailscale-ping`, `real-browser` and `browser-script` (Chromium would
  resolve and connect on its own) and `docker` monitors on a `socket` Docker host are refused while the guard is on, both when
  saving and when the check runs. Database connection strings that point at a unix socket are refused too.
- **`snmp`** supports v1 and v2c; SNMPv3 is not available yet.
- **`websocket-upgrade`** supports none, basic, bearer and mTLS authentication; OAuth2 is not wired.
- **Conditions** (Uptime Kuma's condition builder for mysql/sqlserver/mqtt) are not implemented; the
  SQL types report the row count and MQTT uses keyword or JSON-query matching.
- **Not ported**: `oracledb` (the driver is too heavy for the default image), `docker`, `sip-options`,
  `system-service`, `pm2`.

## Adding a type

1. Create `src/server/monitor-types/<name>.ts` that calls `registerMonitorType({ name, label, group,
check })`. Load heavy clients with `loadOptionalDriver(() => import('<pkg>'), '<pkg>', '<Label>')`
   from `./util` (literal specifier, inside `check()`), add the package to `optionalDependencies` and its
   typings to `devDependencies`.
2. Import the file in `src/server/monitor-types/index.ts`.
3. Add fields to `src/collections/Monitors.ts` (also `MONITOR_TYPES`), run `pnpm generate:types` and
   create a Postgres migration.
4. Add the type to `MONITOR_TYPE_NAMES`, `MONITOR_TYPE_GROUPS` and the `superRefine` rules in
   `src/lib/validation/monitor.ts`, and render its fields in `src/components/monitors/monitor-form.tsx`.
5. Write `src/server/monitor-types/<name>.test.ts` (at least an unreachable-target case and, for
   optional drivers, the missing-driver message) and add the row above.
6. When porting from Uptime Kuma, keep the attribution header and list the file in
   `THIRD_PARTY_NOTICES.md`.

## Push schedules and signals

A push monitor is passive: the job it watches calls `/api/push/<token>` (see
[Integrations](Integrations.md#push-monitors) for the full endpoint reference). The worker's periodic
check (`src/server/monitor-types/push.ts`, rules in `evaluatePush()` in `src/lib/push-schedule.ts`) only
decides whether the next ping is overdue.

| Field             | Meaning                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pushSchedule`    | `interval` (default): a ping is due `interval` seconds after the previous one. `cron`: due at the next occurrence of `pushCron` after the previous ping.                                                       |
| `pushCron`        | Five-field cron expression (`0 2 * * *`), evaluated with [croner](https://github.com/Hexagon/croner). DST-aware: a skipped wall-clock time runs at the first valid instant after it, a repeated one runs once. |
| `pushTimezone`    | IANA zone of the cron expression; `SAME_AS_SERVER` (default) uses the organization's time zone (`settings.timezone`).                                                                                          |
| `pushGrace`       | Seconds a ping may be late, and a started run may take, before the monitor goes DOWN. Empty: 10 % of the interval (at least 1 s), as before; 60 s for cron schedules.                                          |
| `pushMaxDuration` | Optional. A run (from `/start` to its success) that takes longer is reported DOWN, as soon as it is exceeded.                                                                                                  |

Cron monitors are checked every minute whatever `interval` says (`PUSH_CRON_CHECK_SECONDS`); until the
first ping they are PENDING, and DOWN once the first occurrence after the monitor's creation plus grace has
passed. Interval monitors without any ping are DOWN on their first check, as before.

The check decides, in this order: an open run past its grace period or `pushMaxDuration` → DOWN; the last
signal was a failure → DOWN until the next success; a run in progress → UP ("Running for …"); the next
expected ping plus grace has passed → DOWN ("No heartbeat in the time window"); otherwise UP.

Every signal is kept in the `push-events` collection (the monitor page's **Ping log**): kind, message, the
first 10 000 bytes of the request body, run id, exit code and run duration. The newest 100 entries per
monitor are kept; they are deleted with the monitor. Signals are applied by `ingestPushSignal()`
(`src/server/push/signals.ts`), which any transport (HTTP today, e-mail later) calls.
