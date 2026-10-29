import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearRunning, readRunning, writeRunning } from '../src/running.js'
import type { Running } from '../src/source.js'

const entry = (address: string): Running => ({ kind: 'postgres', address, schema: { entities: [] }, passing: [] })

describe('the running Sosies', () => {
  it('lists every one alive, the newest first, and forgets the ones that stopped', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-running-'))
    writeRunning(home, entry('postgres://localhost:7674/a'), process.pid)
    await new Promise((r) => setTimeout(r, 5))
    writeRunning(home, entry('postgres://localhost:7675/b'), process.ppid)
    writeRunning(home, entry('postgres://localhost:7676/gone'), 2 ** 30)
    expect(readRunning(home).map((r) => r.address)).toEqual(['postgres://localhost:7675/b', 'postgres://localhost:7674/a'])
    expect(readdirSync(join(home, 'running')).sort()).toEqual([`${process.pid}.json`, `${process.ppid}.json`].sort())
    clearRunning(home, process.ppid)
    expect(readRunning(home)).toHaveLength(1)
  })

  it('holds nothing real, readable by the owner only', () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-running-'))
    writeRunning(home, entry('postgres://localhost:7674/a'))
    const file = join(home, 'running', `${process.pid}.json`)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['address', 'kind', 'passing', 'pid', 'schema', 'startedAt'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, 'running')).mode & 0o777).toBe(0o700)
    clearRunning(home)
    expect(existsSync(file)).toBe(false)
  })

  it('says how to start Sosie when none runs', () => {
    expect(() => readRunning(mkdtempSync(join(tmpdir(), 'sosie-running-')))).toThrow(/^Sosie is not running\./)
  })
})
