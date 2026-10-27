import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Store, storeDir, storeDirs } from '../src/store.js'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'sosie-store-')), 'one')
const unique = { unique: true, scannable: true }

describe('the mapping store', () => {
  it('keeps its key readable by the owner only', () => {
    const dir = fresh()
    Store.open(dir).close()
    expect(statSync(join(dir, 'key')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'store.db')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(dir, 'key'))).toHaveLength(32)
  })

  it('lets several Sosies start on a new store at once, and gives each fake to one value', async () => {
    const dir = fresh()
    const script = fileURLToPath(new URL('./store-race.mjs', import.meta.url))
    const runs = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, [script, dir])))
    const mappings = runs.map((r) => JSON.parse(r.stdout) as Record<string, string>)
    for (const mapping of mappings) expect(mapping).toEqual(mappings[0])
    const store = Store.open(dir)
    for (const fake of new Set(Object.values(mappings[0]!))) expect(store.reals(fake, 'd')).toHaveLength(1)
    expect(new Set(Object.values(mappings[0]!)).size).toBe(30)
    store.close()
  })

  it('remembers a fake across sessions', () => {
    const dir = fresh()
    const store = Store.open(dir)
    expect(store.fake('d', 'real', unique, () => 'first')).toBe('first')
    store.close()
    const again = Store.open(dir)
    expect(again.fake('d', 'real', unique, () => 'second')).toBe('first')
    expect(again.reals('first')).toEqual(['real'])
  })

  it('never gives a value itself as its fake', () => {
    const store = Store.open(fresh())
    expect(store.fake('d', 'same', unique, (_, attempt) => (attempt === 0 ? 'same' : 'other'))).toBe('other')
  })

  it('keeps a value with nothing to fake as it is, without drawing forever', () => {
    const store = Store.open(fresh())
    for (const nothing of ['', '-', '...', 'NaN', 'infinity']) {
      expect(store.fake('d', nothing, unique, () => nothing)).toBe(nothing)
    }
  })

  it('keeps fakes unique within a domain when asked, and only then', () => {
    const store = Store.open(fresh())
    const draw = (_: Uint8Array, attempt: number) => (attempt < 3 ? 'taken' : `free${attempt}`)
    expect(store.fake('keys', 'a', unique, draw)).toBe('taken')
    expect(store.fake('keys', 'b', unique, draw)).toBe('free3')
    expect(store.fake('other', 'c', unique, draw)).toBe('taken')
    expect(store.fake('totals', 'x', { unique: false, scannable: false }, () => '7')).toBe('7')
    expect(store.fake('totals', 'y', { unique: false, scannable: false }, () => '7')).toBe('7')
    expect(store.reals('7', 'totals').sort()).toEqual(['x', 'y'])
    expect(store.reals('taken').sort()).toEqual(['a', 'c'])
    expect(store.reals('taken', 'keys')).toEqual(['a'])
  })

  it('derives seeds from its key: the same value, the same seed; another store, another', () => {
    const one = Store.open(fresh())
    const two = Store.open(fresh())
    expect(one.seed('d', 'v')).toEqual(one.seed('d', 'v'))
    expect(one.seed('d', 'v')).not.toEqual(one.seed('d', 'w'))
    expect(one.seed('d', 'v')).not.toEqual(two.seed('d', 'v'))
  })

  it('stores no real value in the clear', () => {
    const dir = fresh()
    const store = Store.open(dir)
    store.fake('format:email', 'quill.vantablack@canary-mail.test', unique, () => 'kim@example.net')
    store.close()
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes('vantablack')).toBe(false)
    }
  })

  it('indexes distinctive real values for scan, but not fakes or common ones', () => {
    const store = Store.open(fresh())
    store.fake('format:full_name', 'Quillon Vantablack', unique, () => 'Kim Novak')
    store.fake('users.zip', '602 00', { unique: true, scannable: true }, () => '111 11')
    store.fake('users.created_at', '2025-03-14', { unique: false, scannable: false }, () => '2025-01-01')
    store.fake('users.name', 'Kim Novak', unique, () => 'Eva Black')
    const index = store.scanIndex()
    expect(index.find('quillon vantablack')).toBe('format:full_name')
    expect(index.find('602 00')).toBeUndefined()
    expect(index.find('2025-03-14')).toBeUndefined()
    // 'Kim Novak' is a real value, and also the fake shown for another: not a finding.
    expect(index.find('kim novak')).toBeUndefined()
  })

  it('is one store for every upstream under a home', () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-home-'))
    Store.open(storeDir(home)).close()
    expect(storeDirs(home)).toEqual([join(home, 'store')])
  })
})
