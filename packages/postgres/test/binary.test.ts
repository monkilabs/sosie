import { describe, expect, it } from 'vitest'
import { codecFor, type TypeSend } from '../src/binary.js'

/** Built-in types as pg_type has them, and a domain, an enum and its array as a database would. */
const sends = new Map<number, TypeSend>(
  (
    [
      [16, 'bool', 'boolsend'],
      [17, 'bytea', 'byteasend'],
      [18, 'char', 'charsend'],
      [19, 'name', 'namesend', 18],
      [20, 'int8', 'int8send'],
      [21, 'int2', 'int2send'],
      [22, 'int2vector', 'int2vectorsend', 21],
      [23, 'int4', 'int4send'],
      [25, 'text', 'textsend'],
      [26, 'oid', 'oidsend'],
      [30, 'oidvector', 'oidvectorsend', 26],
      [700, 'float4', 'float4send'],
      [701, 'float8', 'float8send'],
      [1007, '_int4', 'array_send', 23],
      [1009, '_text', 'array_send', 25],
      [1016, '_int8', 'array_send', 20],
      [1082, 'date', 'date_send'],
      [1083, 'time', 'time_send'],
      [1114, 'timestamp', 'timestamp_send'],
      [1184, 'timestamptz', 'timestamptz_send'],
      [1186, 'interval', 'interval_send'],
      [1266, 'timetz', 'timetz_send'],
      [1700, 'numeric', 'numeric_send'],
      [2950, 'uuid', 'uuid_send'],
      [3802, 'jsonb', 'jsonb_send'],
      [869, 'inet', 'inet_send'],
      [650, 'cidr', 'cidr_send'],
      [3220, 'pg_lsn', 'pg_lsn_send'],
      [2206, 'regtype', 'regtypesend'],
      [16385, 'mood', 'enum_send'],
      [16384, '_mood', 'array_send', 16385],
      [16390, 'big_id', 'int8send', 0, 20],
      [16394, 'moods', 'array_send', 0, 16384],
    ] as [number, string, string, number?, number?][]
  ).map(([oid, name, send, elem = 0, base = 0]) => [oid, { name, send, elem, base }]),
)

const codec = (oid: number) => codecFor(oid, sends)!
const hex = (oid: number, text: string) => codec(oid).encode(text).toString('hex')

describe('the binary format', () => {
  it('reads back each type as Postgres writes it', () => {
    const samples: [number, string[]][] = [
      [16, ['t', 'f']],
      [17, ['\\x', '\\x00ff10']],
      [18, ['', 'q', '\\200']],
      [20, ['0', '-9223372036854775808', '9223372036854775807']],
      [21, ['-32768', '7']],
      [23, ['2147483647', '-1']],
      [25, ['', 'Zürich 🏔']],
      [26, ['4294967295']],
      [700, ['1.5', '-0', 'Infinity', 'NaN', '0.1']],
      [701, ['-2.25', '1e+300', '-Infinity', 'NaN', '-0']],
      [1700, ['0', '0.00', '12345.678', '-0.0012', '10000', '0.00001234', '1e0'.replace('e0', ''), 'NaN', 'Infinity', '-Infinity', '99999999.99']],
      [1082, ['2026-11-04', '2000-01-01', '1999-12-31', '0044-03-15 BC', '0001-01-01 BC', '10000-01-01', 'infinity', '-infinity']],
      [1083, ['00:00:00', '12:34:56.789', '24:00:00', '23:59:59.000001']],
      [1266, ['12:34:56+05:30', '00:00:00-03', '01:02:03.5+00', '12:00:00+05:53:28']],
      [1114, ['2026-11-04 12:34:56.789012', '2000-01-01 00:00:00', '1969-07-20 20:17:40', '0044-03-15 12:00:00 BC', 'infinity', '-infinity']],
      [1184, ['2026-11-04 11:34:56.5+00', 'infinity']],
      [1186, ['00:00:00', '1 year 2 mons 3 days 04:05:06.7', '-1 years -2 mons +3 days -04:05:06', '1 day', '-00:00:01', '100:00:00', '1 mon -1 days +00:00:01']],
      [2950, ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']],
      [3802, ['{"a": 1}']],
      [869, ['192.168.0.1', '192.168.0.1/24', '::1', '2001:db8::1/64', '::ffff:1.2.3.4', 'fe80::', '::']],
      [650, ['10.0.0.0/8', '2001:db8::/32']],
      [3220, ['16/B374D848', '0/0']],
      [1007, ['{}', '{1,2,NULL}', '{{1,2},{3,4}}', '[0:1]={5,6}']],
      [1009, ['{a,"b c","",NULL,"NULL","\\\\x"}']],
      [22, ['', '1 2 3']],
      [30, ['23 25']],
      [16385, ['sad']],
      [16384, ['{ok,sad}']],
      [16390, ['42']],
      [16394, ['{sad}']],
    ]
    for (const [oid, texts] of samples) {
      for (const text of texts) expect(codec(oid).decode(codec(oid).encode(text)), `${sends.get(oid)!.name} ${text}`).toBe(text)
    }
  })

  it('writes the bytes Postgres sends', () => {
    expect(hex(23, '1')).toBe('00000001')
    expect(hex(20, '-1')).toBe('ffffffffffffffff')
    // 12345.678: three base-10000 digits, weight 1, positive, three decimals.
    expect(hex(1700, '12345.678')).toBe('0003000100000003' + '0001' + '0929' + '1a7c')
    expect(hex(1700, '-0.0012')).toBe('0001ffff40000004' + '000c')
    expect(hex(1700, '0.00')).toBe('0000000000000002')
    // Days and microseconds since 2000-01-01.
    expect(hex(1082, '2000-01-02')).toBe('00000001')
    expect(hex(1114, '2000-01-01 00:00:01')).toBe('00000000000f4240')
    expect(hex(1184, '2000-01-01 01:00:00+01')).toBe('0000000000000000')
    expect(hex(1266, '00:00:00+01')).toBe('0000000000000000' + 'fffff1f0')
    expect(hex(1186, '1 mon 2 days 00:00:01')).toBe('00000000000f4240' + '00000002' + '00000001')
    expect(hex(3802, '{}')).toBe('017b7d')
    expect(hex(869, '10.0.0.1/8')).toBe('020800040a000001')
    expect(hex(650, '::/0')).toBe('030001100000000000000000000000000000000000'.slice(0, 8 + 32))
    // An array: one dimension, a null, int4 elements, length 2 from 1, then each element.
    expect(hex(1007, '{7,NULL}')).toBe('00000001' + '00000001' + '00000017' + '00000002' + '00000001' + '0000000400000007' + 'ffffffff')
    expect(hex(1007, '{}')).toBe('000000000000000000000017')
  })

  it('refuses an array whose dimensions the message cannot hold, before building anything', () => {
    const header = (ndim: number, dims: number[]) => {
      const b = Buffer.alloc(12 + 8 * dims.length)
      b.writeInt32BE(ndim, 0)
      b.writeUInt32BE(23, 8)
      dims.forEach((d, i) => (b.writeInt32BE(d, 12 + 8 * i), b.writeInt32BE(1, 16 + 8 * i)))
      return b
    }
    // Two billion empty arrays, and no element: this ran Sosie out of memory.
    expect(codec(1007).decode(header(2, [2147483647, 0]))).toBe('{}')
    expect(() => codec(1007).decode(header(1, [100_000_000]))).toThrow(/more elements than the message holds/)
    expect(() => codec(1007).decode(header(2, [65536, 65536]))).toThrow(/more elements/)
    expect(() => codec(1007).decode(header(7, [1, 1, 1, 1, 1, 1, 1]))).toThrow(/7 dimensions/)
    expect(() => codec(1007).decode(header(1, [-1]))).toThrow(/negative/)
  })

  it('reads a domain as its base type, an enum as its label, an array of either by its element', () => {
    expect(hex(16390, '7')).toBe(hex(20, '7'))
    expect(codec(16385).encode('ok').toString()).toBe('ok')
    expect(hex(16394, '{ok}')).toBe(hex(16384, '{ok}'))
  })

  it('has no codec for a type it cannot write from text, and refuses text that is not of the type', () => {
    // regtype's text is a name; its binary is the OID the name stands for.
    expect(codecFor(2206, sends)).toBeUndefined()
    expect(codecFor(99999, sends)).toBeUndefined()
    expect(() => codec(23).encode('seven')).toThrow()
    expect(() => codec(1082).encode('2026-11-04 12:00:00')).toThrow()
    expect(() => codec(1184).encode('2026-11-04 12:00:00')).toThrow()
    expect(() => codec(869).encode('300.1.1.1')).toThrow()
  })
})
