/**
 * Uploads of status page images: the light logo (`logo`), the dark logo (`logoDark`) and the
 * `favicon`. Each kind has its own size cap and allowed formats; the format is detected from the
 * file's bytes (the browser-supplied type is ignored) and SVGs are rebuilt by the allowlist
 * sanitiser before they are stored in `media`.
 */
import { defaultLocale, type Locale } from '@/i18n/locales'
import { translateError } from '@/server/errors'
import { errorText, requestLocale } from '@/server/request-locale'
import { sanitizeSvg, SvgRejectedError } from './svg'
import {
  authenticate,
  errorResponse,
  jsonError,
  loadOrgStatusPage,
  type Authenticated,
} from './http'

export const STATUS_PAGE_ASSET_KINDS = ['logo', 'logoDark', 'favicon'] as const
export type StatusPageAssetKind = (typeof STATUS_PAGE_ASSET_KINDS)[number]

type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'ico' | 'svg'

const MIME: Record<ImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

export const ASSET_RULES: Record<
  StatusPageAssetKind,
  { maxBytes: number; types: readonly ImageType[] }
> = {
  logo: {
    maxBytes: 2 * 1024 * 1024,
    types: ['png', 'jpeg', 'gif', 'webp', 'avif', 'svg'],
  },
  logoDark: {
    maxBytes: 2 * 1024 * 1024,
    types: ['png', 'jpeg', 'gif', 'webp', 'avif', 'svg'],
  },
  favicon: { maxBytes: 100 * 1024, types: ['png', 'ico', 'svg'] },
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  bytes.every((byte, i) => buf[offset + i] === byte)

/** Image format from magic bytes; SVG is recognised by its markup. */
export function sniffImageType(buf: Buffer): ImageType | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (
    buf
      .subarray(0, 6)
      .toString('latin1')
      .match(/^GIF8[79]a$/)
  )
    return 'gif'
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp'
  }
  if (
    buf
      .subarray(4, 12)
      .toString('latin1')
      .match(/^ftypavi[fs]$/)
  )
    return 'avif'
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length > 6 && buf[4] + buf[5] > 0)
    return 'ico'
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '')
  if (
    /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)
  ) {
    return 'svg'
  }
  return null
}

const humanSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KB`

export type PreparedAsset = { data: Buffer; mimetype: string; name: string; size: number }

/** Validates and (for SVG) sanitises an upload, or returns an error message in `locale`. */
export async function prepareAsset(
  kind: StatusPageAssetKind,
  file: File,
  locale: Locale = defaultLocale,
): Promise<{ ok: true; asset: PreparedAsset } | { ok: false; error: string }> {
  const rules = ASSET_RULES[kind]
  if (file.size > rules.maxBytes) {
    return {
      ok: false,
      error: translateError(locale, 'assetTooLarge', { kind, size: humanSize(rules.maxBytes) }),
    }
  }
  let data: Buffer = Buffer.from(await file.arrayBuffer())
  const type = sniffImageType(data)
  if (!type || !rules.types.includes(type)) {
    return {
      ok: false,
      error: translateError(locale, 'assetType', {
        kind,
        types: rules.types.map((t) => t.toUpperCase()).join(', '),
      }),
    }
  }
  if (type === 'svg') {
    try {
      data = Buffer.from(sanitizeSvg(data.toString('utf8')), 'utf8')
    } catch (error) {
      if (error instanceof SvgRejectedError) {
        return { ok: false, error: translateError(locale, 'svgRejected', { reason: error.reason }) }
      }
      throw error
    }
  }
  const base =
    (file.name || kind)
      .replace(/\.[^.]*$/, '')
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || kind
  return {
    ok: true,
    asset: {
      data,
      mimetype: MIME[type],
      name: `${base}.${type === 'jpeg' ? 'jpg' : type}`,
      size: data.length,
    },
  }
}

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

const ALT: Record<StatusPageAssetKind, string> = {
  logo: 'logo',
  logoDark: 'dark logo',
  favicon: 'favicon',
}

async function setAsset(
  { payload, user }: Authenticated,
  pageId: string | number,
  kind: StatusPageAssetKind,
  value: string | number | null,
) {
  return payload.update({
    collection: 'status-pages',
    id: pageId,
    data: { [kind]: value },
    depth: 1,
    user,
    overrideAccess: false,
  })
}

/** POST handler: multipart `file` → `media` row → page field. */
export function uploadAssetHandler(kind: StatusPageAssetKind) {
  return async function POST(request: Request, { params }: RouteContext) {
    const auth = await authenticate(request)
    if (!auth.ok) return auth.response
    const { payload, user } = auth.ctx
    const { orgId, id } = await params

    try {
      const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
      if (!page) return jsonError(errorText(request, 'statusPageNotFound'), 404)

      let form: FormData
      try {
        form = await request.formData()
      } catch {
        return jsonError(errorText(request, 'logoFileRequired'), 400)
      }
      const file = form.get('file')
      if (!(file instanceof File)) return jsonError(errorText(request, 'logoFileRequired'), 400)

      const prepared = await prepareAsset(kind, file, requestLocale(request))
      if (!prepared.ok) return jsonError(prepared.error, 400)

      const media = await payload.create({
        collection: 'media',
        data: { alt: `${page.title} ${ALT[kind]}` },
        file: prepared.asset,
        user,
        overrideAccess: false,
      })
      try {
        return Response.json({ doc: await setAsset(auth.ctx, page.id, kind, media.id) })
      } catch (error) {
        // The page's access rules said no (e.g. a viewer): don't leave an orphaned upload behind.
        await payload
          .delete({ collection: 'media', id: media.id, overrideAccess: true })
          .catch(() => undefined)
        throw error
      }
    } catch (error) {
      return errorResponse(error, request)
    }
  }
}

/** DELETE handler: clears the page field (the media row is kept). */
export function removeAssetHandler(kind: StatusPageAssetKind) {
  return async function DELETE(request: Request, { params }: RouteContext) {
    const auth = await authenticate(request)
    if (!auth.ok) return auth.response
    const { orgId, id } = await params

    try {
      const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
      if (!page) return jsonError(errorText(request, 'statusPageNotFound'), 404)
      return Response.json({ doc: await setAsset(auth.ctx, page.id, kind, null) })
    } catch (error) {
      return errorResponse(error, request)
    }
  }
}
