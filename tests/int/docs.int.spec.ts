import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Documentation consistency. No database involved: these tests read the repository files and make sure
 * the configuration reference and the docs index cannot drift from the code.
 */

const root = process.cwd()
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8')

/**
 * Keys of the zod object in `src/env.ts`. The schema is a module-private `const schema = z.object({...})`,
 * so the keys are extracted textually: an upper-case identifier at the start of a line followed by `:`.
 */
function envSchemaKeys(): string[] {
  const source = read('src/env.ts')
  const start = source.indexOf('z.object({')
  const end = source.indexOf('\n})', start)
  expect(start, 'src/env.ts should declare the schema with z.object({').toBeGreaterThan(-1)
  expect(end, 'src/env.ts schema should be closed by `})` at column 0').toBeGreaterThan(start)
  const body = source.slice(start, end)
  const keys = [...body.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1])
  expect(keys.length).toBeGreaterThan(10)
  return keys
}

/** Relative `.md` links of a Markdown file: `[text](target.md)` and `[text](target.md#anchor)`. */
function markdownLinks(markdown: string): { target: string }[] {
  const links: { target: string }[] = []
  for (const match of markdown.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    const target = match[1]
    if (/^[a-z]+:\/\//.test(target)) continue
    links.push({ target })
  }
  return links
}

/**
 * Pages whose pull requests merge alongside the documentation ("landing in the current release" in the
 * docs). They may be linked before they exist; the release checklist empties this list once they landed.
 */
const LANDING_PAGES: string[] = []

/** Exact-case check for wiki pages (macOS file systems would accept `configuration.md` for `Configuration.md`). */
const pageExists = (target: string) =>
  target.includes('/')
    ? existsSync(path.join(root, 'docs', target))
    : readdirMarkdown('docs').includes(target) || LANDING_PAGES.includes(target)

/** Wiki special pages: the landing page and the navigation shown on every page. */
const NAVIGATION = ['Home.md', '_Sidebar.md']
const WIKI_SPECIAL = [...NAVIGATION, '_Footer.md']

describe('documentation', () => {
  const keys = envSchemaKeys()

  it('documents every environment variable of src/env.ts in docs/Configuration.md', () => {
    const configuration = read('docs/Configuration.md')
    const missing = keys.filter((key) => !configuration.includes(`\`${key}\``))
    expect(missing, 'variables missing from docs/Configuration.md').toEqual([])
  })

  it('lists every environment variable of src/env.ts in .env.example', () => {
    const example = read('.env.example')
    const missing = keys.filter((key) => !new RegExp(`^#?\\s*${key}=`, 'm').test(example))
    expect(missing, 'variables missing from .env.example (as KEY= or # KEY=)').toEqual([])
  })

  it('keeps docs/ in the GitHub wiki layout (flat, Title-Case page names)', () => {
    const entries = readdirSync(path.join(root, 'docs'), { withFileTypes: true })
    const misplaced = entries
      .filter((entry) => !(entry.isFile() && entry.name.endsWith('.md')) && entry.name !== 'images')
      .map((entry) => entry.name)
    expect(misplaced, 'docs/ must only contain .md pages and images/ (the wiki is flat)').toEqual(
      [],
    )

    const badNames = readdirMarkdown('docs').filter(
      (file) =>
        !WIKI_SPECIAL.includes(file) && !/^[A-Z][A-Za-z0-9]*(-[A-Za-z0-9]+)*\.md$/.test(file),
    )
    expect(badNames, 'page names must be Title-Case-With-Hyphens.md').toEqual([])
  })

  it.each(NAVIGATION)('lists every docs page in docs/%s', (nav) => {
    const index = read(path.join('docs', nav))
    const pages = readdirMarkdown('docs').filter((file) => !WIKI_SPECIAL.includes(file))
    const unlisted = pages.filter((file) => !index.includes(`](${file})`))
    expect(unlisted, `docs pages not linked from docs/${nav}`).toEqual([])
  })

  it('links only to existing pages from the docs pages', () => {
    const broken: string[] = []
    for (const file of readdirMarkdown('docs')) {
      for (const { target } of markdownLinks(read(path.join('docs', file)))) {
        if (!pageExists(target)) broken.push(`${file} -> ${target}`)
      }
    }
    expect(broken).toEqual([])
  })
})

function readdirMarkdown(dir: string): string[] {
  return readdirSync(path.join(root, dir))
    .filter((file) => file.endsWith('.md'))
    .sort()
}
