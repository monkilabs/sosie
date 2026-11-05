import type { Field, RequestScope } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import { ArgumentsError, binaryRow, lookupTexts, paramLiteral, readExecute, temporalTexts, TYPE, type Param } from '../src/binary.js'
import { columnName, type Sent } from '../src/errors.js'
import type { Column } from '../src/protocol.js'
import { inClientText, inClientTextEnd, substitute } from '../src/rewrite.js'
import { buildCatalog } from '../src/schema.js'
import { splitStatements } from '../src/split.js'

/** A COM_STMT_EXECUTE as a client writes one: id, no cursor, one iteration, then the null bitmap, types and values. */
function execute(id: number, params: { type: number; unsigned?: boolean; value?: Buffer }[], bind = true): Buffer {
  const head = Buffer.alloc(10)
  head[0] = 0x17
  head.writeUInt32LE(id, 1)
  head.writeUInt32LE(1, 6)
  const nulls = Buffer.alloc((params.length + 7) >> 3)
  params.forEach((p, i) => p.value === undefined && (nulls[i >> 3]! |= 1 << (i & 7)))
  const types = Buffer.concat(params.map((p) => Buffer.from([p.type, p.unsigned ? 0x80 : 0])))
  const values = params.flatMap((p) => (p.value ? [p.value] : []))
  return Buffer.concat([head, nulls, Buffer.from([bind ? 1 : 0]), ...(bind ? [types] : []), ...values])
}

const int64 = (n: bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}
const double = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(n)
  return b
}
const lenenc = (s: string | Buffer) => {
  const bytes = typeof s === 'string' ? Buffer.from(s) : s
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

describe('the parameters of an execution', () => {
  it('reads each type a client binds, a NULL by the bitmap', () => {
    const datetime = Buffer.from([11, 0xe9, 0x07, 3, 14, 9, 26, 53, 0, 0, 0, 0])
    datetime.writeUInt32LE(589000, 8)
    const time = Buffer.from([8, 1, 1, 0, 0, 0, 2, 3, 4])
    const { params, types } = readExecute(
      execute(7, [
        { type: TYPE.LONGLONG, value: int64(-5n) },
        { type: TYPE.LONGLONG, unsigned: true, value: Buffer.from('ffffffffffffffff', 'hex') },
        { type: TYPE.DOUBLE, value: double(0.1) },
        { type: TYPE.VAR_STRING, value: lenenc('it’s') },
        { type: TYPE.BLOB, value: lenenc(Buffer.from([0xde, 0xad])) },
        { type: TYPE.DATETIME, value: datetime },
        { type: TYPE.TIME, value: time },
        { type: TYPE.NEWDECIMAL, value: lenenc('12.50') },
        { type: TYPE.VAR_STRING },
      ]),
      9,
      undefined,
      new Map(),
    )
    expect(params).toEqual([
      { kind: 'integer', text: '-5' },
      { kind: 'integer', text: '18446744073709551615' },
      { kind: 'double', value: 0.1 },
      { kind: 'string', bytes: Buffer.from('it’s') },
      { kind: 'binary', bytes: Buffer.from([0xde, 0xad]) },
      { kind: 'temporal', text: '2025-03-14 09:26:53.589000', type: 'datetime' },
      { kind: 'temporal', text: '-26:03:04', type: 'time' },
      { kind: 'decimal', text: '12.50' },
      { kind: 'null' },
    ])
    expect(types).toHaveLength(18)
  })

  it('reuses the types bound before when an execution sends none, and takes data sent ahead in its place', () => {
    const types = Buffer.from([TYPE.VAR_STRING, 0, TYPE.LONG, 0])
    const four = Buffer.alloc(4)
    four.writeInt32LE(42)
    const payload = execute(1, [{ type: TYPE.VAR_STRING }, { type: TYPE.LONG, value: four }], false)
    // The first parameter's value came ahead, with COM_STMT_SEND_LONG_DATA: neither in the bitmap nor in the packet.
    payload[10] = 0
    const { params } = readExecute(payload, 2, types, new Map([[0, [Buffer.from('ab'), Buffer.from('cd')]]]))
    expect(params).toEqual([
      { kind: 'string', bytes: Buffer.from('abcd') },
      { kind: 'integer', text: '42' },
    ])
  })

  it('refuses an execution cut short, or with no types', () => {
    const cut = execute(1, [{ type: TYPE.LONGLONG, value: int64(1n) }]).subarray(0, 16)
    expect(() => readExecute(cut, 1, undefined, new Map())).toThrow(ArgumentsError)
    // A length that says more bytes of itself follow, and none do.
    for (const prefix of [0xfc, 0xfd, 0xfe]) {
      expect(() => readExecute(execute(1, [{ type: TYPE.VAR_STRING, value: Buffer.from([prefix]) }]), 1, undefined, new Map())).toThrow(ArgumentsError)
    }
    expect(() => readExecute(execute(1, [{ type: TYPE.LONG }], false), 1, undefined, new Map())).toThrow(ArgumentsError)
  })
})

describe('a parameter as a literal', () => {
  const email = { id: 'users.email', name: 'email', type: { kind: 'string' } } as Field
  const avatar = { id: 'users.avatar', name: 'avatar', type: { kind: 'bytes' } } as Field

  it('writes each kind as MySQL reads it, spaced from the text around it', () => {
    const cases: [Param, string | undefined][] = [
      [{ kind: 'null' }, ' NULL '],
      [{ kind: 'integer', text: '7' }, ' 7 '],
      [{ kind: 'integer', text: '-7' }, ' (-7) '],
      [{ kind: 'double', value: 5 }, ' 5 '],
      [{ kind: 'double', value: 0.1 }, ' 1e-1 '],
      [{ kind: 'double', value: Number.NaN }, undefined],
      [{ kind: 'decimal', text: '12.50' }, ' 12.50 '],
      [{ kind: 'string', bytes: Buffer.from("O'Brien\\") }, " 'O\\'Brien\\\\' "],
      [{ kind: 'string', bytes: Buffer.from([0xff, 0xfe]) }, " X'fffe' "],
      [{ kind: 'binary', bytes: Buffer.from('ab') }, " X'6162' "],
      [{ kind: 'temporal', text: '2025-03-14 09:26:53.589000', type: 'datetime' }, " '2025-03-14 09:26:53.589' "],
    ]
    for (const [param, literal] of cases) expect(paramLiteral(param, undefined, undefined)).toBe(literal)
  })

  it('writes the real value a fake stands for, binary kept binary, bytes as hex', () => {
    expect(paramLiteral({ kind: 'string', bytes: Buffer.from('fake@example.com') }, 'real@x.test', email)).toBe(" 'real@x.test' ")
    expect(paramLiteral({ kind: 'binary', bytes: Buffer.from('fake@example.com') }, 'real@x.test', email)).toBe(` X'${Buffer.from('real@x.test').toString('hex')}' `)
    expect(paramLiteral({ kind: 'binary', bytes: Buffer.from([1, 2]) }, '\\xdeadbeef', avatar)).toBe(" X'deadbeef' ")
    expect(paramLiteral({ kind: 'double', value: 8 }, '1', undefined)).toBe(' 1 ')
  })

  it('looks a fake up by the text it was shown as', () => {
    expect(lookupTexts({ kind: 'binary', bytes: Buffer.from([0xde, 0xad]) }, avatar)).toEqual(['\\xdead'])
    expect(lookupTexts({ kind: 'string', bytes: Buffer.from('x@y.z') }, email)).toEqual(['x@y.z'])
    expect(temporalTexts('2025-03-14 09:26:53.589000')).toEqual(['2025-03-14 09:26:53.589000', '2025-03-14 09:26:53.58900', '2025-03-14 09:26:53.5890', '2025-03-14 09:26:53.589'])
    // A DATETIME(3) prints .000 at a whole second: each length is a form a fake may have been shown in.
    expect(temporalTexts('2025-03-14 00:00:00')).toEqual([
      '2025-03-14 00:00:00.000000',
      '2025-03-14 00:00:00.00000',
      '2025-03-14 00:00:00.0000',
      '2025-03-14 00:00:00.000',
      '2025-03-14 00:00:00.00',
      '2025-03-14 00:00:00.0',
      '2025-03-14 00:00:00',
      '2025-03-14',
    ])
  })
})

describe('a result row in binary', () => {
  const col = (type: number, flags = 0): Column => ({ schema: '', table: '', orgTable: '', name: 'c', orgName: '', characterSet: 63, length: 0, type, flags, decimals: 0 })

  it('writes each value in its column’s form, NULL in the bitmap past its two reserved bits', () => {
    const columns = [col(TYPE.TINY), col(TYPE.LONGLONG, 32), col(TYPE.DOUBLE), col(TYPE.DATETIME), col(TYPE.TIME), col(TYPE.VAR_STRING), col(TYPE.LONG)]
    const row = binaryRow(
      [Buffer.from('-1'), Buffer.from('18446744073709551615'), Buffer.from('1.5'), Buffer.from('2024-02-29 10:11:12.000007'), Buffer.from('-838:59:59'), Buffer.from('hé'), null],
      columns,
    )
    expect(row[0]).toBe(0)
    // Seven columns, offset by two: bit 8 of the bitmap is the seventh column's.
    expect([...row.subarray(1, 3)]).toEqual([0, 1])
    let at = 3
    const take = (n: number) => row.subarray(at, (at += n))
    expect(take(1).readInt8()).toBe(-1)
    expect(take(8).readBigUInt64LE()).toBe(18446744073709551615n)
    expect(take(8).readDoubleLE()).toBe(1.5)
    expect([...take(12)]).toEqual([11, 0xe8, 0x07, 2, 29, 10, 11, 12, 7, 0, 0, 0])
    expect([...take(9)]).toEqual([8, 1, 34, 0, 0, 0, 22, 59, 59])
    expect(take(4).toString()).toBe('\x03hé')
    expect(at).toBe(row.length)
  })

  it('writes a zero date as nothing, and a value that does not read as its type as NULL', () => {
    const row = binaryRow([Buffer.from('0000-00-00'), Buffer.from('not a number')], [col(TYPE.DATE), col(TYPE.LONG)])
    // The second column's NULL is bit 3: the bitmap's first two bits are reserved.
    expect([...row]).toEqual([0, 0b1000, 0])
  })
})

describe('several statements in a query', () => {
  it('splits at semicolons outside quotes and comments', () => {
    expect(splitStatements("SELECT 'a;b'; SELECT \"c\\\";d\"; SELECT `e;f`")).toEqual(["SELECT 'a;b'", ' SELECT "c\\";d"', ' SELECT `e;f`'])
    expect(splitStatements('SELECT 1 -- a;b\n; SELECT 2 # c;d\n;SELECT 3 /* e;f */;')).toEqual(['SELECT 1 -- a;b\n', ' SELECT 2 # c;d\n', 'SELECT 3 /* e;f */', ''])
    // --1 is minus minus one, not a comment.
    expect(splitStatements('SELECT 1--1;SELECT 2')).toEqual(['SELECT 1--1', 'SELECT 2'])
    expect(splitStatements("SELECT 'it''s;'; SELECT 2")).toEqual(["SELECT 'it''s;'", ' SELECT 2'])
  })
})

describe('a result column’s name', () => {
  const catalog = buildCatalog({ database: 'app', tables: [], columns: [], primary: [], unique: [], references: [], functions: [], grants: [] })
  const scope = { scrub: (t: string) => t.split('real@x.test').join('fake@example.com') } as unknown as RequestScope
  const text = "SELECT email = 'fake@example.com', ? + 1 FROM users"
  const at = text.indexOf("'fake")
  const rewritten = substitute(text, [
    { start: at, end: at + 18, literal: "'real@x.test'" },
    { start: text.indexOf('?'), end: text.indexOf('?') + 1, literal: ' 5 ' },
  ])!
  const sent: Sent = { text, sql: rewritten.sql, edits: rewritten.edits, scope }

  it('is the client’s own text where MySQL named it by what Sosie sent', () => {
    expect(sent.sql).toBe("SELECT email = 'real@x.test',  5  + 1 FROM users")
    expect(columnName("email = 'real@x.test'", sent, catalog)).toBe("email = 'fake@example.com'")
    expect(columnName('5  + 1', sent, catalog)).toBe('? + 1')
    expect(columnName('5', sent, catalog)).toBe('?')
    // Cut at 255 characters inside the value: the client's literal, whole.
    expect(columnName("email = 'real@x", sent, catalog)).toBe("email = 'fake@example.com'")
    expect(columnName('email', sent, catalog)).toBe('email')
  })

  it('is scrubbed, and its quotes masked, where it is not in what Sosie sent', () => {
    expect(columnName("upper('real@x.test')", sent, catalog)).toBe("upper('fake@example.com')")
    expect(columnName("x('elsewhere')", sent, catalog)).toBe("x('…')")
  })

  it('maps a stretch of what was sent back to the client’s text', () => {
    const start = sent.sql.indexOf('real')
    expect(inClientText(start, sent.edits)).toBe(at)
    expect(inClientTextEnd(start + 4, sent.edits)).toBe(at + 18)
    expect(inClientTextEnd(sent.sql.length, sent.edits)).toBe(text.length)
  })
})
