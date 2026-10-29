import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, pacer, Store } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import { fakeBody, type FakeContext } from '../src/fake.js'
import { route } from '../src/paths.js'

describe('faking a body', () => {
  it('lets other work in while a large body is faked', async () => {
    const store = Store.open(join(mkdtempSync(join(tmpdir(), 'sosie-rest-fake-')), 'store'))
    const schema = { entities: [] }
    const faker = createFaker({ schema, rules: loadRules('', schema, 'sosie.yml', { learns: true }), store })
    const ctx: FakeContext = { faker, api: undefined, fields: new Map(), entityFor: (w) => w, url: () => undefined, maxItems: 10_000, pace: pacer(0) }
    let done = false
    const faking = fakeBody(
      Array.from({ length: 2000 }, (_, i) => ({ id: i + 1 })),
      route(['big'], [], (w) => w, () => false),
      ctx,
    ).then((faked) => {
      done = true
      return faked
    })
    // Work that came in after faking began runs before it ends.
    expect(await new Promise((resolve) => setImmediate(() => resolve(done)))).toBe(false)
    expect((await faking).body).toHaveLength(2000)
    store.close()
  })
})
