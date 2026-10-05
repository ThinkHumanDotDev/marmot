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
const LANDING_PAGES = ['integrations.md', 'telemetry.md', 'billing.md']

const pageExists = (target: string) =>
  existsSync(path.join(root, 'docs', target)) || LANDING_PAGES.includes(target)

describe('documentation', () => {
  const keys = envSchemaKeys()

  it('documents every environment variable of src/env.ts in docs/configuration.md', () => {
    const configuration = read('docs/configuration.md')
    const missing = keys.filter((key) => !configuration.includes(`\`${key}\``))
    expect(missing, 'variables missing from docs/configuration.md').toEqual([])
  })

  it('lists every environment variable of src/env.ts in .env.example', () => {
    const example = read('.env.example')
    const missing = keys.filter((key) => !new RegExp(`^#?\\s*${key}=`, 'm').test(example))
    expect(missing, 'variables missing from .env.example (as KEY= or # KEY=)').toEqual([])
  })

  it('links only to existing pages from docs/README.md', () => {
    const index = read('docs/README.md')
    const links = markdownLinks(index)
    expect(links.length).toBeGreaterThan(10)

    const broken = links.map(({ target }) => target).filter((target) => !pageExists(target))
    expect(broken, 'links in docs/README.md to files that do not exist').toEqual([])
  })

  it('lists every docs page in docs/README.md', () => {
    const index = read('docs/README.md')
    const pages = readdirMarkdown('docs').filter((file) => file !== 'README.md')
    const unlisted = pages.filter((file) => !index.includes(`](${file})`))
    expect(unlisted, 'docs pages not linked from docs/README.md').toEqual([])
  })

  it('links only to existing pages from the other docs pages', () => {
    const broken: string[] = []
    for (const file of readdirMarkdown('docs')) {
      if (file === 'README.md') continue
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
