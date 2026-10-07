/**
 * Entry point of the `marmot` CLI (#116). Bundled by scripts/build-server.mjs into the
 * self-contained `dist/cli/marmot.mjs` (the package's `bin`); in a checkout run it with `pnpm marmot`.
 * See docs/CLI.md.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'

import type { CliIo } from './context'
import { run } from './run'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const io: CliIo = {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stdout.isTTY),
  interactive: Boolean(process.stdin.isTTY),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  readStdin,
  async confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await rl.question(`${question} `)
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  },
}

run(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exitCode = 1
  },
)
