#!/usr/bin/env node
/**
 * What CI's release job publishes after a push to main: the packages' version, once no tag names it. A release's pull
 * request sets that version and dates its section of the CHANGELOG, so its merge publishes it; any other push
 * releases nothing.
 *
 * node scripts/release-plan.mjs <notes file> prints `version=…` and `release=true` or `false`, as GitHub Actions reads
 * a step's outputs, and for a release writes its notes to the file: the CHANGELOG's section for the version, and how
 * to install it, as every release's notes have. It stops, with nothing published:
 * - when the tags cannot be read: a version would seem to be untagged and be released again;
 * - at a version below the latest tag, which npm would serve as the latest;
 * - at a version such as 1.0.0-rc.1, which npm would serve as the latest too;
 * - when the CHANGELOG has no section for the version, as the release would have no notes.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const fail = (message) => {
  console.error(`  ✗ ${message} Nothing was published.`)
  process.exit(1)
}

const notes = process.argv[2]
if (!notes) fail('Usage: node scripts/release-plan.mjs <notes file>.')
// Every package is at this version: test/release.test.ts fails a pull request that moves only some.
const { version } = JSON.parse(readFileSync(new URL('packages/cli/package.json', root), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`CI releases versions such as 1.2.3 only: npm would serve ${version} as the latest.`)

const git = spawnSync('git', ['ls-remote', '--tags', '--refs', 'origin'], { cwd: root, encoding: 'utf8' })
if (git.status !== 0) fail(`The tags could not be read: ${(git.stderr || git.error?.message || '').trim()}.`)

const parts = (text) => text.split('.').map(Number)
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const tags = [...git.stdout.matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)$/gm)].map((m) => parts(m[1])).sort(compare)
const install = (version) => `## Install

\`\`\`sh
npx @sosie/cli@${version}
\`\`\`

In Claude Code, with Sosie's MCP server and skill:

\`\`\`sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
\`\`\`
`
const output = (release) => process.stdout.write(`version=${version}\nrelease=${release}\n`)

if (tags.some((tag) => compare(tag, parts(version)) === 0)) {
  console.error(`  ✓ v${version} is tagged already: nothing to release.`)
  output(false)
} else {
  const latest = tags.at(-1)
  if (latest && compare(latest, parts(version)) > 0) fail(`${version} is below v${latest.join('.')}, the latest tag: npm would serve it as the latest.`)
  const lines = readFileSync(new URL('CHANGELOG.md', root), 'utf8').split('\n')
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version},`))
  if (start < 0) fail(`CHANGELOG.md has no section for ${version}: a release's pull request dates the Unreleased one.`)
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  writeFileSync(notes, `${lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()}\n\n${install(version)}`)
  console.error(`  ✓ ${version} is not tagged yet: it is released, with the CHANGELOG's section for it as its notes.`)
  output(true)
}
