import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BADGE_EMBED_OPTIONS,
  statusPageBadgeSnippets,
  statusPageBadgeUrl,
  statusPageBaseUrl,
} from './status-page-badge'

describe('status page badge embeds', () => {
  it('points at the page on the main host or at the root of a custom domain', () => {
    expect(statusPageBaseUrl('https://marmot.example.com/', 'acme')).toBe(
      'https://marmot.example.com/status/acme',
    )
    expect(statusPageBaseUrl('https://marmot.example.com', 'acme', 'status.acme.com')).toBe(
      'https://status.acme.com',
    )
  })

  it('only adds parameters that differ from the defaults', () => {
    const page = 'https://m.test/status/acme'
    expect(statusPageBadgeUrl(page, DEFAULT_BADGE_EMBED_OPTIONS)).toBe(`${page}/badge.svg`)
    expect(
      statusPageBadgeUrl(page, {
        ...DEFAULT_BADGE_EMBED_OPTIONS,
        theme: 'dark',
        size: 'lg',
        variant: 'outline',
        label: ' Acme API ',
      }),
    ).toBe(`${page}/badge.svg?theme=dark&size=lg&variant=outline&label=Acme+API`)
    // Shields styles ignore the pill options.
    expect(
      statusPageBadgeUrl(page, { ...DEFAULT_BADGE_EMBED_OPTIONS, style: 'flat', theme: 'dark' }),
    ).toBe(`${page}/badge.svg?style=flat`)
  })

  it('builds escaped Markdown and HTML snippets', () => {
    const snippets = statusPageBadgeSnippets({
      pageUrl: 'https://status.acme.com',
      badgeUrl: 'https://status.acme.com/badge.svg?style=flat&label=A',
      alt: 'Acme [EU] "status"',
    })
    expect(snippets.markdown).toBe(
      '[![Acme \\[EU\\] "status"](https://status.acme.com/badge.svg?style=flat&label=A)](https://status.acme.com)',
    )
    expect(snippets.html).toBe(
      '<a href="https://status.acme.com"><img src="https://status.acme.com/badge.svg?style=flat&amp;label=A" alt="Acme [EU] &quot;status&quot;"></a>',
    )
  })
})
