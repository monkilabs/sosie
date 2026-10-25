import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scan } from '../src/scan.js'
import { Store } from '../src/store.js'

describe('sosie scan', () => {
  const store = Store.open(join(mkdtempSync(join(tmpdir(), 'sosie-scan-')), 'store'))
  const unique = { unique: true, scannable: true }
  store.fake('format:email', 'quill.vantablack@canary-mail.test', unique, () => 'kim@example.net')
  store.fake('format:full_name', 'Quillon Vantablack', unique, () => 'Kim Novak')
  store.fake('users.account', '7739182046', unique, () => '1234567890')
  store.fake('users.id', '4821', unique, () => '9')
  const index = store.scanIndex()

  const dir = mkdtempSync(join(tmpdir(), 'sosie-transcripts-'))
  writeFileSync(
    join(dir, 'leaky.jsonl'),
    [
      '{"role":"tool","content":"kim@example.net, Kim Novak"}',
      '{"role":"tool","content":"QUILLON  vantablack."}',
      '{"role":"assistant","content":"order 4821 on port 5432"}',
      '{"role":"tool","content":"mail: <Quill.Vantablack@canary-mail.test>"}',
      '{"role":"tool","content":"account 7739182046"}',
    ].join('\n'),
  )
  // As transcripts hold them: values right after JSON escapes.
  writeFileSync(
    join(dir, 'escaped.jsonl'),
    [
      '{"content":"email\\nquill.vantablack@canary-mail.test\\n(1 row)"}',
      '{"content":"name\\tQuillon Vantablack"}',
      '{"content":"\\u0051uillon Vantablack"}',
    ].join('\n'),
  )
  writeFileSync(join(dir, 'clean.md'), 'Kim Novak (kim@example.net) owns account 1234567890.\n')
  writeFileSync(join(dir, 'image.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('Quillon Vantablack')]))
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'node_modules', 'x.js'), 'Quillon Vantablack')

  it('finds real values whatever their case and punctuation, and says where, never what', async () => {
    const result = await scan([dir], [index])
    expect(result.findings).toEqual([
      { file: join(dir, 'escaped.jsonl'), line: 1, domain: 'format:email' },
      { file: join(dir, 'escaped.jsonl'), line: 2, domain: 'format:full_name' },
      { file: join(dir, 'escaped.jsonl'), line: 3, domain: 'format:full_name' },
      { file: join(dir, 'leaky.jsonl'), line: 2, domain: 'format:full_name' },
      { file: join(dir, 'leaky.jsonl'), line: 4, domain: 'format:email' },
      { file: join(dir, 'leaky.jsonl'), line: 5, domain: 'users.account' },
    ])
  })

  it('counts the text files it read, skipping binaries and node_modules', async () => {
    expect((await scan([dir], [index])).files).toBe(3)
  })

  it('finds nothing in fakes', async () => {
    expect((await scan([join(dir, 'clean.md')], [index])).findings).toEqual([])
  })
})
