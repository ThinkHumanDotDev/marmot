/** Entry point of the Marmot GitHub Action, bundled into `action/dist/index.mjs`. */
import { appendFile, readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { annotation } from './github'
import { runAction } from './main'

runAction({
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  readFile: (path) => readFile(path, 'utf8'),
  appendFile: (path, text) => appendFile(path, text, 'utf8'),
  sleep: (ms) => sleep(ms).then(() => undefined),
}).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stdout.write(annotation('error', message))
    process.exitCode = 1
  },
)
