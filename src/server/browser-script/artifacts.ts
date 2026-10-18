/**
 * Storage of Browser Script screenshots and traces (#139) in the `check-artifacts` upload
 * collection, and their inline form for checks that store nothing (the editor's "Run now").
 */
import type { Payload } from 'payload'

import type { BrowserArtifactRef, BrowserCheckDetails } from '@/lib/browser-script'
import { childLogger } from '@/lib/logger'
import type { CheckArtifact } from '@/payload-types'

import type { CheckArtifactFile } from './run'

const log = childLogger('browser-script:artifacts')

/** Largest screenshot returned inline by an unrecorded check (it travels through Redis). */
export const INLINE_SCREENSHOT_MAX_BYTES = 1024 * 1024

const toRef = (doc: CheckArtifact): BrowserArtifactRef => ({
  id: String(doc.id),
  kind: doc.kind,
  url: doc.url ?? '',
  filename: doc.filename ?? doc.kind,
  filesize: typeof doc.filesize === 'number' ? doc.filesize : null,
})

/**
 * Store the files of a check and return references to them. A file that cannot be stored is
 * logged and skipped: losing a screenshot never loses the heartbeat.
 */
export async function storeCheckArtifacts(
  payload: Payload,
  options: {
    files: readonly CheckArtifactFile[]
    monitorId: string | number
    organizationId: string | number
    heartbeatId: string | number
  },
): Promise<BrowserArtifactRef[]> {
  const refs: BrowserArtifactRef[] = []
  for (const file of options.files) {
    try {
      const doc = (await payload.create({
        collection: 'check-artifacts',
        overrideAccess: true,
        depth: 0,
        data: {
          organization: options.organizationId as CheckArtifact['organization'],
          monitor: options.monitorId as CheckArtifact['monitor'],
          heartbeat: options.heartbeatId as CheckArtifact['heartbeat'],
          kind: file.kind,
        },
        file: {
          data: file.data,
          mimetype: file.mimeType,
          name: `${options.monitorId}-${options.heartbeatId}-${file.filename}`,
          size: file.data.length,
        },
      })) as CheckArtifact
      refs.push(toRef(doc))
    } catch (err) {
      log.warn({ err, monitorId: options.monitorId, kind: file.kind }, 'failed to store artifact')
    }
  }
  return refs
}

/** The details of an unrecorded check, with the screenshot inline (the trace is left out). */
export function withInlineScreenshot(
  details: BrowserCheckDetails,
  files: readonly CheckArtifactFile[] | null | undefined,
): BrowserCheckDetails {
  const screenshot = files?.find((file) => file.kind === 'screenshot')
  if (!screenshot || screenshot.data.length > INLINE_SCREENSHOT_MAX_BYTES) return details
  return {
    ...details,
    screenshotDataUrl: `data:${screenshot.mimeType};base64,${screenshot.data.toString('base64')}`,
  }
}
