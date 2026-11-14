#!/usr/bin/env node
/**
 * Every package published, as one release. CI's release job runs it once a release's pull request merges
 * (scripts/release-plan.mjs says when); npm run release runs it by hand, from a checkout of the release's commit.
 *
 * - On the Node the packages need, or not at all: an older one fails the tests on what it prints, not on the code.
 * - After every check, as CI runs them. With --checked it runs none: CI's release job passes it, after every other
 *   job of the run passed on the same commit.
 * - One package at a time, in the order the workspaces list them, the core first and the CLI last, each after every
 *   package it depends on. One that fails stops the rest, so what is on npm always installs: a source never needs a
 *   core that is not out yet.
 * - A package already on npm at this version is passed over, so running it again after a stop finishes the release.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const manifest = (dir) => JSON.parse(readFileSync(new URL(`${dir}/package.json`, root), 'utf8'))
const { engines, workspaces } = manifest('.')
const checked = process.argv.includes('--checked')

const need = Number(/\d+/.exec(engines.node)[0])
if (Number(process.versions.node.split('.')[0]) < need) {
  console.error(`  ✗ This is Node ${process.versions.node}; the packages need ${engines.node}. Run nvm use: .nvmrc names the one CI tests.`)
  process.exit(1)
}

const npm = (args, stdio = 'inherit') => spawnSync('npm', args, { cwd: root, stdio, encoding: 'utf8' })

if (!checked && npm(['run', 'check']).status !== 0) {
  console.error('  ✗ A check failed: nothing was published.')
  process.exit(1)
}

for (const dir of workspaces) {
  const { name, version } = manifest(dir)
  if (npm(['view', `${name}@${version}`, 'version'], 'pipe').stdout?.trim() === version) {
    console.log(`  ✓ ${name}@${version} is on npm already`)
    continue
  }
  // By hand, npm asks in the terminal for a one-time password, one package at a time; CI's token needs none.
  if (npm(['publish', '--workspace', dir]).status !== 0) {
    const again = checked ? 'Re-running the job publishes the rest.' : 'npm run release again publishes the rest.'
    console.error(`  ✗ ${name}@${version} was not published, nor those after it. ${again}`)
    process.exit(1)
  }
  console.log(`  ✓ ${name}@${version} published`)
}
