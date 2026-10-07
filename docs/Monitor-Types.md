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
keyword, JSON query, TCP port, ping, DNS and gRPC monitors.

| Type                | Label                                      | Fields                                                                                                                                                                                                   | Driver / requirement                 |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `http`              | HTTP(s)                                    | `url`, `method`, `httpBodyEncoding`, `body`, `headers`, `acceptedStatusCodes`, `maxRedirects`, `ignoreTls`, `expiryNotification`, `authMethod` + credentials, `assertions`                               | — (undici)                           |
| `keyword`           | HTTP(s) - Keyword                          | HTTP fields + `keyword`, `invertKeyword`                                                                                                                                                                 | —                                    |
| `json-query`        | HTTP(s) - Json Query                       | HTTP fields + `jsonPath`, `jsonPathOperator`, `expectedValue`                                                                                                                                            | — (jsonata)                          |
| `real-browser`      | HTTP(s) - Browser Engine (Chrome/Chromium) | `url`, `remoteBrowser` (ws:// URL of a Playwright-compatible browser server), `ignoreTls`                                                                                                                | `playwright-core` + a remote browser |
| `port`              | TCP Port                                   | `hostname`, `port`                                                                                                                                                                                       | —                                    |
| `ping`              | Ping                                       | `hostname`                                                                                                                                                                                               | system `ping` binary                 |
| `dns`               | DNS                                        | `hostname`, `port` (53), `dnsResolveServer`, `dnsResolveType`, `assertions` (dnsRecord)                                                                                                                  | —                                    |
| `push`              | Push                                       | `pushToken` (generated); the client calls `/api/push/<token>`                                                                                                                                            | —                                    |
| `manual`            | Manual                                     | `manualStatus`                                                                                                                                                                                           | —                                    |
| `group`             | Group                                      | children via `parent`                                                                                                                                                                                    | —                                    |
| `grpc-keyword`      | gRPC(s) - Keyword                          | `grpcUrl`, `grpcProtobuf`, `grpcServiceName`, `grpcMethod`, `grpcEnableTls`, `grpcBody`, `grpcMetadata`, `keyword`, `invertKeyword`                                                                      | `@grpc/grpc-js`, `protobufjs`        |
| `websocket-upgrade` | WebSocket Upgrade                          | `url` (ws:// or wss://), `acceptedStatusCodes` (close codes, default `1000`), `headers`, `wsSubprotocol`, `wsIgnoreSecWebsocketAcceptHeader`, `ignoreTls`, `authMethod` basic/bearer/mTLS                | `ws`                                 |
| `mqtt`              | MQTT                                       | `hostname` (scheme optional: mqtt, mqtts, ws, wss), `port` (1883), `mqttTopic`, `mqttUsername`, `mqttPassword`, `mqttCheckType` keyword \| json-query, `mqttSuccessMessage`, `jsonPath`, `expectedValue` | `mqtt`                               |
| `kafka-producer`    | Kafka Producer                             | `kafkaProducerBrokers`, `kafkaProducerTopic`, `kafkaProducerMessage`, `kafkaProducerSsl`, `kafkaProducerAllowAutoTopicCreation`, `kafkaProducerSaslOptions` (JSON)                                       | `kafkajs`                            |
| `rabbitmq`          | RabbitMQ                                   | `rabbitmqNodes` (management API URLs), `rabbitmqUsername`, `rabbitmqPassword`                                                                                                                            | — (fetch)                            |
| `smtp`              | SMTP                                       | `hostname`, `port` (25), `smtpSecurity` opportunistic \| starttls \| secure \| nostarttls, `ignoreTls`                                                                                                   | — (nodemailer)                       |
| `snmp`              | SNMP                                       | `hostname`, `port` (161), `snmpOid`, `snmpVersion` 1 \| 2c, `snmpCommunity`, optional `jsonPath`, `jsonPathOperator`, `expectedValue`                                                                    | `net-snmp`                           |
| `ntp`               | NTP                                        | `hostname`, `port` (123); fails on stratum ≥ 5 or 16, \|offset\| ≥ 1000 ms, dispersion ≥ 500 ms                                                                                                          | —                                    |
| `sftp`              | SFTP                                       | `hostname`, `port` (22), `sshUsername`, `sshAuthMethod` password \| privateKey, `sshPassword`, `sshPrivateKey`, `sshPassphrase`, `sftpPath`                                                              | `ssh2-sftp-client`                   |
| `radius`            | Radius                                     | `hostname`, `port` (1812), `radiusUsername`, `radiusPassword`, `radiusSecret`, `radiusCalledStationId`, `radiusCallingStationId`                                                                         | `radius`                             |
| `tailscale-ping`    | Tailscale Ping                             | `hostname`                                                                                                                                                                                               | `tailscale` CLI on the worker host   |
| `mysql`             | MySQL/MariaDB                              | `databaseConnectionString` (`mysql://…`), `databaseQuery` (default `SELECT 1`)                                                                                                                           | `mysql2`                             |
| `postgres`          | PostgreSQL                                 | `databaseConnectionString` (`postgres://…`), `databaseQuery` (default `SELECT 1`)                                                                                                                        | `pg`                                 |
| `sqlserver`         | Microsoft SQL Server                       | `databaseConnectionString` (`Server=…;Database=…;User Id=…;Password=…`), `databaseQuery` (default `SELECT 1`)                                                                                            | `mssql`                              |
| `mongodb`           | MongoDB                                    | `databaseConnectionString` (`mongodb://…`), `databaseQuery` (JSON command, default `{"ping": 1}`), optional `jsonPath`, `expectedValue`                                                                  | `mongodb`                            |
| `redis`             | Redis                                      | `databaseConnectionString` (`redis://…` or `rediss://…`), `ignoreTls`                                                                                                                                    | — (ioredis)                          |
| `steam`             | Steam Game Server                          | `hostname`, `port`; `steamApiKey` instance setting                                                                                                                                                       | Steam Web API key                    |
| `gamedig`           | GameDig                                    | `hostname`, `port`, `game` (GameDig id), `gamedigGivenPortOnly`                                                                                                                                          | `gamedig`                            |

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
  most 500 characters. Each match runs in a `node:vm` context with a 50 ms timeout, so a pattern with
  catastrophic backtracking fails the assertion instead of stalling the worker. Regexes inside JSONata
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
  all addresses before connecting. `tailscale-ping`, `real-browser` (Chromium would resolve and connect on
  its own) and `docker` monitors on a `socket` Docker host are refused while the guard is on, both when
  saving and when the check runs. Database connection strings that point at a unix socket are refused too.
- **`snmp`** supports v1 and v2c; SNMPv3 is not available yet.
- **`websocket-upgrade`** supports none, basic, bearer and mTLS authentication; OAuth2 is not wired.
- **Conditions** (Uptime Kuma's condition builder for mysql/sqlserver/mqtt) are not implemented; the
  SQL types report the row count and MQTT uses keyword or JSON-query matching.
- **Not ported**: `oracledb` (the driver is too heavy for the default image), `docker`, `sip-options`,
  `system-service`, `globalping`, `pm2`.

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
