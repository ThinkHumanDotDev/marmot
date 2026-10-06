import type { SsoDomain } from '@/payload-types'

import { verificationRecord } from './domains'

/** A domain as Settings → Security shows it, with the DNS record to add. */
export interface SsoDomainRow {
  id: SsoDomain['id']
  domain: string
  verifiedAt: string | null
  record: { name: string; type: 'TXT'; value: string }
  createdAt: string
}

export const toDomainRow = (domain: SsoDomain): SsoDomainRow => ({
  id: domain.id,
  domain: domain.domain,
  verifiedAt: domain.verifiedAt ?? null,
  record: verificationRecord(domain),
  createdAt: domain.createdAt,
})
