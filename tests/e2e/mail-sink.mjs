#!/usr/bin/env node
// Minimal SMTP sink for the e2e suite: the web and worker processes send mail to it (`SMTP_HOST`,
// `SMTP_PORT` in playwright.config.ts), and specs read what was sent over HTTP, so flows that
// depend on an emailed link (sign-in links, #164) can be tested end to end. Started by the
// Playwright `webServer` list. Plain SMTP only (no STARTTLS, no AUTH), messages kept in memory.
//
//   GET    /health          → 200 {"ok":true}
//   GET    /messages?to=a@b → 200 [{ to, subject, text }] (decoded bodies, oldest first)
//   DELETE /messages        → 204, forgets every message
import http from 'node:http'
import net from 'node:net'

const smtpPort = Number(process.argv[2] || process.env.E2E_SMTP_PORT || 3003)
const httpPort = Number(process.argv[3] || process.env.E2E_MAIL_PORT || 3004)

/** @type {{ to: string[], subject: string, text: string }[]} */
let messages = []

const decodeQuotedPrintable = (input) =>
  Buffer.from(
    input
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  ).toString('utf8')

function splitHeaders(raw) {
  const index = raw.search(/\r?\n\r?\n/)
  const head = index === -1 ? raw : raw.slice(0, index)
  const body = index === -1 ? '' : raw.slice(index).replace(/^\r?\n\r?\n/, '')
  const headers = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { headers, body }
}

/** Decoded text of every leaf part (text and HTML alike), joined. */
function decodeBody(raw) {
  const { headers, body } = splitHeaders(raw)
  const type = headers['content-type'] ?? 'text/plain'
  const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1]
  if (/^multipart\//i.test(type) && boundary) {
    return body
      .split(`--${boundary}`)
      .slice(1)
      .filter((part) => !part.startsWith('--'))
      .map((part) => decodeBody(part.replace(/^\r?\n/, '')))
      .join('\n')
  }
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

const decodeSubject = (value = '') =>
  value.replace(/=\?utf-8\?([BQ])\?([^?]*)\?=/gi, (_, kind, text) =>
    kind.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : decodeQuotedPrintable(text.replace(/_/g, ' ')),
  )

const smtp = net.createServer((socket) => {
  let buffer = ''
  let inData = false
  let recipients = []
  const reply = (line) => socket.write(`${line}\r\n`)
  reply('220 marmot-e2e-mail-sink ESMTP')

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n')
        if (end === -1) return
        const raw = buffer.slice(0, end).replace(/^\.\./gm, '.')
        buffer = buffer.slice(end + 5)
        inData = false
        const { headers } = splitHeaders(raw)
        messages.push({
          to: recipients,
          subject: decodeSubject(headers.subject),
          text: decodeBody(raw),
        })
        recipients = []
        reply('250 OK: queued')
        continue
      }
      const newline = buffer.indexOf('\r\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 2)
      const command = line.slice(0, 4).toUpperCase()
      if (command === 'EHLO') {
        reply('250-marmot-e2e-mail-sink')
        reply('250 8BITMIME')
      } else if (command === 'HELO') reply('250 marmot-e2e-mail-sink')
      else if (command === 'MAIL') reply('250 OK')
      else if (command === 'RCPT') {
        const address = line.match(/<([^>]*)>/)?.[1]
        if (address) recipients.push(address.toLowerCase())
        reply('250 OK')
      } else if (command === 'DATA') {
        inData = true
        reply('354 End data with <CR><LF>.<CR><LF>')
      } else if (command === 'RSET') {
        recipients = []
        reply('250 OK')
      } else if (command === 'NOOP') reply('250 OK')
      else if (command === 'QUIT') {
        reply('221 Bye')
        socket.end()
        return
      } else reply('502 Command not implemented')
    }
  })
  socket.on('error', () => undefined)
})

const api = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (url.pathname === '/messages' && req.method === 'DELETE') {
    messages = []
    res.writeHead(204)
    res.end()
    return
  }
  if (url.pathname === '/messages') {
    const to = url.searchParams.get('to')?.toLowerCase()
    const list = to ? messages.filter((message) => message.to.includes(to)) : messages
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(list.map((message) => ({ ...message, to: message.to.join(', ') }))))
    return
  }
  res.writeHead(404)
  res.end()
})

smtp.listen(smtpPort, '127.0.0.1', () => {
  api.listen(httpPort, '127.0.0.1', () => {
    console.log(`e2e mail sink: SMTP 127.0.0.1:${smtpPort}, messages http://127.0.0.1:${httpPort}`)
  })
})
