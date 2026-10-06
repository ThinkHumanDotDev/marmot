#!/usr/bin/env node
// Builds the GitHub wiki from docs/ (published by .github/workflows/wiki.yml).
//
//   node scripts/build-wiki.mjs <wiki-dir> [--repo owner/name] [--ref main]
//
// docs/ is already laid out as a wiki: flat, Title-Case page names (`Getting-Started.md` becomes the
// "Getting Started" page), `Home.md` as the landing page plus `_Sidebar.md` and `_Footer.md`. The pages
// link with `Page.md` so they also work when browsed in the repository; the wiki wants extensionless
// `Page` links and cannot resolve `../` paths, so this script rewrites both. Screenshots live in
// docs/images/ and are copied as they are. Every page and image in <wiki-dir> is replaced, so files removed
// from docs/ disappear from the wiki too.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? 'ThinkHumanDotDev/marmot' },
    ref: { type: 'string', default: 'main' },
  },
})
const target = positionals[0]
if (!target) {
  console.error('usage: build-wiki.mjs <wiki-dir> [--repo owner/name] [--ref main]')
  process.exit(2)
}

const source = path.join(import.meta.dirname, '..', 'docs')
const repoUrl = `https://github.com/${values.repo}/blob/${values.ref}`

/** `](Page.md#anchor)` -> `](Page#anchor)`, `](../path)` -> `](https://github.com/<repo>/blob/<ref>/path)`. */
function toWiki(markdown) {
  return markdown
    .replace(
      /\]\(([A-Za-z0-9_-]+)\.md(#[^)\s]*)?\)/g,
      (_, page, anchor = '') => `](${page}${anchor})`,
    )
    .replace(/\]\(\.\.\/([^)\s]+)\)/g, (_, file) => `](${repoUrl}/${file})`)
}

mkdirSync(target, { recursive: true })
for (const file of readdirSync(target)) {
  if (file.endsWith('.md') || file === 'images')
    rmSync(path.join(target, file), { recursive: true })
}
if (existsSync(path.join(source, 'images'))) {
  cpSync(path.join(source, 'images'), path.join(target, 'images'), { recursive: true })
}
const pages = readdirSync(source).filter((file) => file.endsWith('.md'))
for (const file of pages) {
  writeFileSync(path.join(target, file), toWiki(readFileSync(path.join(source, file), 'utf8')))
}
console.log(`wrote ${pages.length} wiki pages to ${target}`)
