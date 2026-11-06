import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(root, 'scripts', 'release.mjs')
const manifest = (dir: string) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
const { workspaces, engines } = manifest('.') as { workspaces: string[]; engines: { node: string } }

/**
 * npm run release, with an npm of the test's own on PATH that publishes nothing: it writes down each call, and fails
 * the check or a package's publish as told. `published` are the packages on npm at this version already.
 */
function release({ node, failCheck = false, published = [], failPublish = '' }: { node?: string; failCheck?: boolean; published?: string[]; failPublish?: string } = {}) {
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
  const result = spawnSync(process.execPath, [...older, SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] }
}

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
