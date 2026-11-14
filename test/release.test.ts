import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(root, 'scripts', 'release.mjs')
const PLAN = join(root, 'scripts', 'release-plan.mjs')
const manifest = (dir: string) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
const { workspaces, engines } = manifest('.') as { workspaces: string[]; engines: { node: string } }

/**
 * npm run release, with an npm of the test's own on PATH that publishes nothing: it writes down each call, and fails
 * the check or a package's publish as told. `published` are the packages on npm at this version already.
 */
function release({
  node,
  checked = false,
  failCheck = false,
  published = [],
  failPublish = '',
}: { node?: string; checked?: boolean; failCheck?: boolean; published?: string[]; failPublish?: string } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'sosie-npm-'))
  const log = join(bin, 'calls')
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  run) [ "${failCheck ? 1 : 0}" = 0 ] ;;
  view) for p in ${published.join(' ')}; do [ "\${2%@*}" = "$p" ] && echo "\${2##*@}"; done; true ;;
  publish) [ "$3" != "${failPublish}" ] ;;
esac
`,
  )
  chmodSync(join(bin, 'npm'), 0o755)
  // Another Node, as the one a shell's nvm may pick: the version the script reads, the rest this one.
  const older = node ? ['--import', `data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"${node}"}})`] : []
  const result = spawnSync(process.execPath, [...older, SCRIPT, ...(checked ? ['--checked'] : [])], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] }
}

/** What every release's notes end with: how to install that version. */
const install = (version: string) =>
  `## Install\n\n\`\`\`sh\nnpx @sosie/cli@${version}\n\`\`\`\n\nIn Claude Code, with Sosie's MCP server and skill:\n\n` +
  '```sh\nclaude plugin marketplace add monkilabs/sosie\nclaude plugin install sosie@sosie\n```\n'

/**
 * CI's release plan, with a git of the test's own on PATH that lists the tags given, or fails. With `before`, it runs
 * as after a push: the commit before it, 5e1d0a, has `@sosie/cli` at that version, unless `failFetch`. Without, as by
 * hand. With `tree`, the plan runs in a repository of its own, with that version and CHANGELOG; otherwise in this one.
 */
function plan({
  tags = [],
  failGit = false,
  before,
  failFetch = false,
  tree,
}: { tags?: string[]; failGit?: boolean; before?: string; failFetch?: boolean; tree?: { version: string; changelog: string } } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'sosie-git-'))
  const listed = tags.map((tag) => `printf '0f3c1e\\trefs/tags/%s\\n' '${tag}'`).join('; ')
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
case "$*" in
  "ls-remote --tags --refs origin") ${failGit ? "echo 'fatal: unable to access the remote' >&2; exit 128" : listed || 'true'} ;;
  "fetch --quiet --no-tags --depth=1 origin 5e1d0a") ${failFetch ? "echo 'fatal: remote error: upload-pack: not our ref 5e1d0a' >&2; exit 128" : 'true'} ;;
  "show 5e1d0a:packages/cli/package.json") echo '{ "name": "@sosie/cli", "version": "${before}" }' ;;
  *) echo "git $* was not expected" >&2; exit 2 ;;
esac
`,
  )
  chmodSync(join(bin, 'git'), 0o755)
  let script = PLAN
  if (tree) {
    const own = mkdtempSync(join(tmpdir(), 'sosie-repo-'))
    mkdirSync(join(own, 'scripts'))
    mkdirSync(join(own, 'packages', 'cli'), { recursive: true })
    script = join(own, 'scripts', 'release-plan.mjs')
    copyFileSync(PLAN, script)
    writeFileSync(join(own, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@sosie/cli', version: tree.version }))
    writeFileSync(join(own, 'CHANGELOG.md'), tree.changelog)
  }
  const notes = join(bin, 'notes.md')
  const since = before !== undefined || failFetch ? ['--since', '5e1d0a'] : []
  const result = spawnSync(process.execPath, [script, notes, ...since], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, notes: existsSync(notes) ? readFileSync(notes, 'utf8') : undefined }
}

const version = (manifest('packages/cli') as { version: string }).version
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

describe('npm run release', () => {
  it('stops on a Node older than the packages need, before it runs anything, and says which to use', () => {
    const result = release({ node: '22.21.1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`  ✗ This is Node 22.21.1; the packages need ${engines.node}. Run nvm use: .nvmrc names the one CI tests.\n`)
    expect(result.calls).toEqual([])
  })

  it('publishes nothing when a check fails', () => {
    const result = release({ failCheck: true })
    expect(result.status).toBe(1)
    expect(result.calls).toEqual(['run check'])
    expect(result.stderr).toBe('  ✗ A check failed: nothing was published.\n')
  })

  it('publishes one package at a time, in the workspaces’ order, passing over one on npm already', () => {
    const result = release({ published: ['@sosie/core'] })
    expect(result.status).toBe(0)
    const versions = workspaces.map((dir) => manifest(dir) as { name: string; version: string })
    expect(result.calls).toEqual([
      'run check',
      ...versions.flatMap(({ name, version }, i) => [`view ${name}@${version} version`, ...(name === '@sosie/core' ? [] : [`publish --workspace ${workspaces[i]}`])]),
    ])
    expect(result.stdout).toContain(`  ✓ @sosie/core@${versions[0]!.version} is on npm already\n`)
  })

  it('stops at a package that fails, and publishes none after it', () => {
    const result = release({ failPublish: 'packages/mysql' })
    expect(result.status).toBe(1)
    const at = workspaces.indexOf('packages/mysql')
    expect(result.calls.filter((c) => c.startsWith('publish'))).toEqual(workspaces.slice(0, at + 1).map((dir) => `publish --workspace ${dir}`))
    expect(result.stderr).toContain('was not published, nor those after it. npm run release again publishes the rest.')
  })

  it('runs no check with --checked, as CI does after every other job passed on the commit, and says to re-run the job', () => {
    const passed = release({ checked: true })
    expect(passed.status).toBe(0)
    expect(passed.calls).toEqual(workspaces.flatMap((dir) => [`view ${manifest(dir).name}@${manifest(dir).version} version`, `publish --workspace ${dir}`]))
    const stopped = release({ checked: true, failPublish: 'packages/mysql' })
    expect(stopped.status).toBe(1)
    expect(stopped.stderr).toContain('was not published, nor those after it. Re-running the job publishes the rest.')
  })

  it('runs on the Node .nvmrc names, which the packages take and CI tests', () => {
    const nvmrc = Number(readFileSync(join(root, '.nvmrc'), 'utf8').trim())
    expect(nvmrc).toBeGreaterThanOrEqual(Number(/\d+/.exec(engines.node)![0]))
    expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toMatch(new RegExp(`node-version: ${nvmrc}\\b`))
  })
})

describe('the order packages are published in', () => {
  it('has each package after every package of Sosie’s it depends on: the core first, the CLI last', () => {
    const names = workspaces.map((dir) => manifest(dir).name as string)
    for (const [i, dir] of workspaces.entries()) {
      const needs = Object.keys(manifest(dir).dependencies ?? {}).filter((n) => n.startsWith('@sosie/'))
      for (const name of needs) expect(names.indexOf(name), `${names[i]} needs ${name}`).toBeLessThan(i)
    }
    expect([names[0], names.at(-1)]).toEqual(['@sosie/core', '@sosie/cli'])
  })
})

describe('a release', () => {
  it('moves every package to one version, each depending on the others at it', () => {
    for (const dir of workspaces) {
      const { name, version: own, dependencies = {} } = manifest(dir) as { name: string; version: string; dependencies?: Record<string, string> }
      expect(own, name).toBe(version)
      for (const [needed, range] of Object.entries(dependencies)) if (needed.startsWith('@sosie/')) expect(range, `${name} needs ${needed}`).toBe(`^${version}`)
    }
  })

  it('dates the CHANGELOG’s section for that version, which becomes its notes', () => {
    expect(changelog).toMatch(new RegExp(`^## ${version.replaceAll('.', '\\.')}(,|$)`, 'm'))
  })
})

describe('the release plan, after a push to main', () => {
  const [major] = version.split('.').map(Number) as [number]

  it('releases nothing after a push that does not move the version, though no tag names it: the docs, a README or code', () => {
    const result = plan({ tags: ['v0.0.1'], before: version })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`version=${version}\nrelease=false\n`)
    expect(result.stderr).toBe(
      `  ✓ This push does not move the version: nothing to release. ${version} is not released yet: re-run the job of\n` +
        '    the push that moved it, or run CI on main by hand (Actions → CI → Run workflow), to release it.\n',
    )
    expect(result.notes).toBeUndefined()
  })

  it('releases the version a push moved, as run by hand releases one no tag names', () => {
    const pushed = plan({ tags: ['v0.0.1'], before: '0.0.1' })
    expect(pushed.status).toBe(0)
    expect(pushed.stdout).toBe(`version=${version}\nrelease=true\n`)
    expect(pushed.notes).toBe(plan({ tags: ['v0.0.1'] }).notes)
  })

  it('stops when the commit before the push cannot be read, as the push would seem to move the version', () => {
    const result = plan({ tags: ['v0.0.1'], failFetch: true })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      '  ✗ The commit before the push, 5e1d0a, could not be read: fatal: remote error: upload-pack: not our ref 5e1d0a. Nothing was published.\n',
    )
    expect(result.notes).toBeUndefined()
  })

  it('releases nothing when a tag names the version', () => {
    const result = plan({ tags: ['v0.0.1', `v${version}`, 'latest'] })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`version=${version}\nrelease=false\n`)
    expect(result.stderr).toBe(`  ✓ v${version} is tagged already: nothing to release.\n`)
    expect(result.notes).toBeUndefined()
  })

  it('releases a version no tag names yet, its notes the CHANGELOG’s section for it and how to install it; the first one too', () => {
    const start = changelog.indexOf('\n', changelog.search(new RegExp(`^## ${version.replaceAll('.', '\\.')}(,|$)`, 'm'))) + 1
    const end = changelog.indexOf('\n## ', start)
    const section = `${changelog.slice(start, end < 0 ? undefined : end).trim()}\n`
    for (const tags of [['v0.0.1', 'latest'], []]) {
      const result = plan({ tags })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`version=${version}\nrelease=true\n`)
      expect(result.notes).toBe(`${section}\n${install(version)}`)
    }
    expect(section).not.toMatch(/^#/m)
  })

  it('takes the last section, and a heading with no date', () => {
    const result = plan({ tree: { version: '2.0.0', changelog: '# Changelog\n\n## 2.0.0\n\nThe last one.\n' } })
    expect(result.stdout).toBe('version=2.0.0\nrelease=true\n')
    expect(result.notes).toBe(`The last one.\n\n${install('2.0.0')}`)
  })

  it('stops, with nothing published, at a version below the latest tag', () => {
    const result = plan({ tags: [`v${major + 1}.0.0`, 'v0.0.1'] })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`  ✗ ${version} is below v${major + 1}.0.0, the latest tag: npm would serve it as the latest. Nothing was published.\n`)
    expect(result.notes).toBeUndefined()
  })

  it('stops when the tags cannot be read, as the version would seem untagged and be released again', () => {
    const result = plan({ failGit: true })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('  ✗ The tags could not be read: fatal: unable to access the remote. Nothing was published.\n')
  })

  it('stops at a version npm would serve as the latest though it is a prerelease, and at one the CHANGELOG has no section for', () => {
    const changelog = '# Changelog\n\n## Unreleased\n\nSoon.\n\n## 2.0.1, 1 December 2026\n\nA fix.\n'
    const prerelease = plan({ tree: { version: '2.1.0-rc.1', changelog } })
    expect(prerelease.status).toBe(1)
    expect(prerelease.stderr).toBe('  ✗ CI releases versions such as 1.2.3 only: npm would serve 2.1.0-rc.1 as the latest. Nothing was published.\n')
    const undated = plan({ tree: { version: '2.1.0', changelog } })
    expect(undated.status).toBe(1)
    expect(undated.stdout).toBe('')
    expect(undated.stderr).toBe(
      "  ✗ CHANGELOG.md has no section for 2.1.0: a release's pull request dates the Unreleased one. Nothing was published.\n",
    )
    expect(undated.notes).toBeUndefined()
  })
})
