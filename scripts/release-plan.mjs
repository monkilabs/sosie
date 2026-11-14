#!/usr/bin/env node
/**
 * What CI's release job publishes after a push to main: the packages' version, when the push moved it and no tag names
 * it yet. A release's pull request sets that version and dates its section of the CHANGELOG, so its merge publishes it.
 * Any other push releases nothing, the docs, a README or the code alike, even while a version is not released yet: a
 * release whose job stopped is finished by re-running that job, or by running CI on main by hand.
 *
 * node scripts/release-plan.mjs <notes file> [--since <commit>] prints `version=…` and `release=true` or `false`, as
 * GitHub Actions reads a step's outputs, and for a release writes its notes to the file: the CHANGELOG's section for
 * the version, and how to install it, as every release's notes have. --since names the commit before the push; run by
 * hand, there is none. It stops, with nothing published:
 * - when the tags cannot be read: a version would seem to be untagged and be released again;
 * - when the commit before the push cannot be read: the push would seem to move the version;
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

const [notes, flag, since] = process.argv.slice(2)
if (!notes || (flag !== undefined && (flag !== '--since' || !since))) fail('Usage: node scripts/release-plan.mjs <notes file> [--since <commit>].')
// Every package is at this version: test/release.test.ts fails a pull request that moves only some.
const MANIFEST = 'packages/cli/package.json'
const { version } = JSON.parse(readFileSync(new URL(MANIFEST, root), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`CI releases versions such as 1.2.3 only: npm would serve ${version} as the latest.`)

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
const why = (run) => (run.stderr || run.error?.message || '').trim()
const remote = git('ls-remote', '--tags', '--refs', 'origin')
if (remote.status !== 0) fail(`The tags could not be read: ${why(remote)}.`)

const parts = (text) => text.split('.').map(Number)
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const tags = [...remote.stdout.matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)$/gm)].map((m) => parts(m[1])).sort(compare)
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
/** Whether the push moved the version: it is another at the commit before it. A branch's first push has none. */
function moved(before) {
  if (/^0+$/.test(before)) return true
  const fetched = git('fetch', '--quiet', '--no-tags', '--depth=1', 'origin', before)
  const shown = fetched.status === 0 ? git('show', `${before}:${MANIFEST}`) : fetched
  if (shown.status !== 0) fail(`The commit before the push, ${before}, could not be read: ${why(shown)}.`)
  return JSON.parse(shown.stdout).version !== version
}
const output = (release) => process.stdout.write(`version=${version}\nrelease=${release}\n`)

if (tags.some((tag) => compare(tag, parts(version)) === 0)) {
  console.error(`  ✓ v${version} is tagged already: nothing to release.`)
  output(false)
} else if (since && !moved(since)) {
  console.error(`  ✓ This push does not move the version: nothing to release. ${version} is not released yet: re-run the job of`)
  console.error('    the push that moved it, or run CI on main by hand (Actions → CI → Run workflow), to release it.')
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
