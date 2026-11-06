import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearRunning, readRunning, writeRunning } from '../src/running.js'
import type { Running } from '../src/source.js'

const source = (address: string, name = 'db'): Running => ({ name, kind: 'postgres', address, schema: { entities: [] }, passing: [] })
const entry = (address: string): Running[] => [source(address)]

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

  it('lists the newest Sosie first, whichever entry is read first', () => {
    // Entries are read in the order of their files, named by pid: each order once.
    for (const [older, newer] of [[process.pid, process.ppid], [process.ppid, process.pid]]) {
      const home = mkdtempSync(join(tmpdir(), 'sosie-running-'))
      writeRunning(home, entry('postgres://localhost:7674/older'), older, 1000)
      writeRunning(home, entry('postgres://localhost:7675/newer'), newer, 2000)
      expect(readRunning(home).map((r) => r.address)).toEqual(['postgres://localhost:7675/newer', 'postgres://localhost:7674/older'])
    }
  })

  it('holds nothing real, readable by the owner only', () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-running-'))
    writeRunning(home, entry('postgres://localhost:7674/a'))
    const file = join(home, 'running', `${process.pid}.json`)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['pid', 'sources', 'startedAt'])
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sources[0]).sort()).toEqual(['address', 'kind', 'name', 'passing', 'schema'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, 'running')).mode & 0o777).toBe(0o700)
    clearRunning(home)
    expect(existsSync(file)).toBe(false)
  })

  it('is written again as a schema grows, whole, and stays as old as the Sosie that wrote it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-running-'))
    const startedAt = Date.now()
    writeRunning(home, entry('http://localhost:7674/v1'), process.pid, startedAt)
    await new Promise((r) => setTimeout(r, 5))
    writeRunning(home, entry('http://localhost:7675/v1'), process.ppid)
    const grown: Running[] = [{ ...source('http://localhost:7674/v1'), schema: { entities: [{ id: 'user', name: 'user', fields: [] }] } }]
    writeRunning(home, grown, process.pid, startedAt)
    // The second Sosie is still the newest: the first one's entry, written again, kept when it started.
    expect(readRunning(home).map((r) => r.address)).toEqual(['http://localhost:7675/v1', 'http://localhost:7674/v1'])
    expect(readRunning(home)[1]!.schema.entities.map((e) => e.id)).toEqual(['user'])
    expect(readdirSync(join(home, 'running')).filter((f) => f.endsWith('.draft'))).toEqual([])
  })

  it('lists each source of a Sosie, in its order, and reads an earlier version’s entry as one source', () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-running-'))
    writeRunning(home, [source('postgres://localhost:7674/shop', 'shop'), source('http://localhost:7675/v1', 'billing')], process.pid)
    expect(readRunning(home).map((r) => r.name)).toEqual(['shop', 'billing'])
    const old = mkdtempSync(join(tmpdir(), 'sosie-running-'))
    mkdirSync(join(old, 'running'))
    writeFileSync(join(old, 'running', `${process.pid}.json`), JSON.stringify({ pid: process.pid, startedAt: 1, kind: 'mysql', address: 'mysql://127.0.0.1:7674/crm', schema: { entities: [] }, passing: [] }))
    expect(readRunning(old)).toEqual([{ name: 'mysql', kind: 'mysql', address: 'mysql://127.0.0.1:7674/crm', schema: { entities: [] }, passing: [] }])
  })

  it('says how to start Sosie when none runs', () => {
    expect(() => readRunning(mkdtempSync(join(tmpdir(), 'sosie-running-')))).toThrow(/^Sosie is not running\./)
  })
})
