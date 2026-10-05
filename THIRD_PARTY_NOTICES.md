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
under `.claude/skills/payload` is Payload's official agent skill (MIT).
