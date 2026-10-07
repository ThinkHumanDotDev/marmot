/**
 * Apprise provider: shells out to the `apprise` CLI, which fans out to 100+ services.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/apprise.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { spawn } from 'node:child_process'
import { z } from 'zod'

import { assertHostLocalAllowed } from '@/server/security/outbound-guard'
import { OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const appriseConfigSchema = z.object({
  appriseUrl: z.string().min(1),
  title: z.string().optional(),
})

export type AppriseConfig = z.infer<typeof appriseConfigSchema>

export const appriseFieldMeta: Record<keyof AppriseConfig, NotificationFieldMeta> = {
  appriseUrl: {
    label: 'Apprise URL',
    placeholder: 'mailto://user:pass@example.com, tgram://bottoken/chatid',
    secret: true,
    description:
      'One or more Apprise service URLs. The `apprise` binary must be installed on the worker host.',
  },
  title: { label: 'Title', placeholder: 'Marmot' },
}

export interface AppriseRunResult {
  stdout: string
  stderr: string
  code: number | null
}

export type AppriseRunner = (args: string[]) => Promise<AppriseRunResult>

/** Spawn the real binary; rejects with a readable error when it is not installed. */
export const runAppriseBinary: AppriseRunner = (args) =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('apprise', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'The apprise CLI is not installed on this host (install it with `pip install apprise`).',
          ),
        )
        return
      }
      reject(err)
    })
    child.once('close', (code) => resolve({ stdout, stderr, code }))
  })

let runApprise: AppriseRunner = runAppriseBinary

/** Tests swap the spawn for a stub. */
export function setAppriseRunner(runner: AppriseRunner | null): void {
  runApprise = runner ?? runAppriseBinary
}

registerNotificationProvider({
  name: 'apprise',
  label: 'Apprise',
  group: 'generic',
  docsUrl: 'https://github.com/caronc/apprise/wiki',
  configSchema: appriseConfigSchema,
  fieldMeta: appriseFieldMeta,
  async send({ config: raw, message }) {
    const config = appriseConfigSchema.parse(raw)
    // The apprise CLI makes its own connections, which the outbound address guard cannot vet.
    assertHostLocalAllowed('The Apprise CLI')
    const args = ['-vv', '-b', message, config.appriseUrl]
    if (config.title) args.push('-t', config.title)

    const result = await runApprise(args)
    const output = `${result.stdout}${result.stderr}`.trim()
    if (output.includes('ERROR')) throw new Error(output)
    if (result.code !== null && result.code !== 0) {
      throw new Error(output || `apprise exited with code ${result.code}`)
    }
    return output ? OK_MESSAGE : 'No output from apprise'
  },
})
