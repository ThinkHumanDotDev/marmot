#!/usr/bin/env node
// Tiny HTTP server that e2e monitors check, so the suite never depends on the network or on the web
// app checking itself. Started by the Playwright `webServer` list (see playwright.config.ts).
//
//   GET /health  → 200 {"ok":true}
//   GET /down    → 503
//   anything else → 200 "ok"
import http from 'node:http'

const port = Number(process.argv[2] || process.env.E2E_TARGET_PORT || 3002)

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0]
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (path === '/down') {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('unavailable')
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`e2e target server listening on http://127.0.0.1:${port}`)
})

const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
