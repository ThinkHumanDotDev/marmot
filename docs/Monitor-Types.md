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
not repeated below.

| Type                | Label                                      | Fields                                                                                                                                                                                                   | Driver / requirement                 |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `http`              | HTTP(s)                                    | `url`, `method`, `httpBodyEncoding`, `body`, `headers`, `acceptedStatusCodes`, `maxRedirects`, `ignoreTls`, `expiryNotification`, `authMethod` + credentials                                             | — (undici)                           |
| `keyword`           | HTTP(s) - Keyword                          | HTTP fields + `keyword`, `invertKeyword`                                                                                                                                                                 | —                                    |
| `json-query`        | HTTP(s) - Json Query                       | HTTP fields + `jsonPath`, `jsonPathOperator`, `expectedValue`                                                                                                                                            | — (jsonata)                          |
| `real-browser`      | HTTP(s) - Browser Engine (Chrome/Chromium) | `url`, `remoteBrowser` (ws:// URL of a Playwright-compatible browser server), `ignoreTls`                                                                                                                | `playwright-core` + a remote browser |
| `port`              | TCP Port                                   | `hostname`, `port`                                                                                                                                                                                       | —                                    |
| `ping`              | Ping                                       | `hostname`                                                                                                                                                                                               | system `ping` binary                 |
| `dns`               | DNS                                        | `hostname`, `port` (53), `dnsResolveServer`, `dnsResolveType`                                                                                                                                            | —                                    |
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
