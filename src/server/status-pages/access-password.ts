import { ValidationError, type CollectionBeforeChangeHook } from 'payload'

import {
  STATUS_PAGE_PASSWORD_MAX_LENGTH,
  STATUS_PAGE_PASSWORD_MIN_LENGTH,
} from '@/lib/status-page-access'
import { hashPassword } from '@/server/security/password-hash'

import type { StatusPage } from '@/payload-types'

type PageData = Partial<StatusPage> & { password?: unknown }

const invalid = (message: string): never => {
  throw new ValidationError({
    collection: 'status-pages',
    errors: [{ message, path: 'password' }],
  })
}

/**
 * `beforeChange` of `status-pages`: turns the write-only `password` into `passwordHash`.
 *
 * - `access: 'password'` needs a password: a new one in `password`, or the stored hash.
 * - A new password replaces the hash. The access cookie embeds a fingerprint of the hash, so every
 *   existing visitor session ends.
 * - Any other access mode drops the hash; switching protection back on asks for a new password.
 *
 * `passwordHash` itself has `create`/`update` field access `false`, so clients can never write it;
 * Payload fills `data.passwordHash` with the stored value on updates before this hook runs.
 */
export const applyAccessPassword: CollectionBeforeChangeHook<StatusPage> = async ({
  data,
  originalDoc,
}) => {
  const page = data as PageData
  const plain = page.password
  delete page.password

  const access = page.access ?? originalDoc?.access ?? 'public'
  if (access !== 'password') {
    page.passwordHash = null
    return data
  }

  if (typeof plain === 'string' && plain.length > 0) {
    if (plain.length < STATUS_PAGE_PASSWORD_MIN_LENGTH) {
      invalid(`The password must be at least ${STATUS_PAGE_PASSWORD_MIN_LENGTH} characters.`)
    }
    if (plain.length > STATUS_PAGE_PASSWORD_MAX_LENGTH) {
      invalid(`The password must be at most ${STATUS_PAGE_PASSWORD_MAX_LENGTH} characters.`)
    }
    page.passwordHash = await hashPassword(plain)
    return data
  }

  const stored = page.passwordHash ?? originalDoc?.passwordHash
  if (!stored) invalid('Set a password to protect this page.')
  page.passwordHash = stored
  return data
}
