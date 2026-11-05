import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { canariesIn } from './canaries.js'
import { startSosie } from './sosie.js'
import { extended } from './wire.js'

/**
 * Binary results and parameters, as asyncpg, pgx and JDBC use them. Sosie reads upstream as text and fakes it; what
 * it writes in binary must be, byte for byte, what Postgres's own send function writes for that text.
 */

let sosie: Awaited<ReturnType<typeof startSosie>>
let port: number
let upstream: pg.Client

beforeAll(async () => {
  sosie = await startSosie()
  port = Number(new URL(sosie.address).port)
  upstream = new pg.Client({ connectionString: inject('upstream') })
  await upstream.connect()
})

afterAll(async () => {
  await upstream.end()
  await sosie.close()
})

const JSONB = 3802

/** What Postgres sends in binary for a value of this type, written as this text: its send function's bytes. */
async function postgresSends(oid: number, text: string): Promise<string> {
  const type = (await upstream.query<{ name: string; send: string }>('SELECT typname::text AS name, typsend::text AS send FROM pg_type WHERE oid = $1', [oid])).rows[0]!
  return (await upstream.query<{ hex: string }>(`SELECT encode(${type.send}($1::"${type.name}"), 'hex') AS hex`, [text])).rows[0]!.hex
}

/** The query as text and in binary through Sosie: each binary value is what Postgres sends for the text one. */
async function asPostgresSends(sql: string, { exactJson = true } = {}) {
  const text = await extended(port, sql, { resultFormats: [0] })
  const binary = await extended(port, sql, { resultFormats: [1] })
  expect(text.error).toBeUndefined()
  expect(binary.error).toBeUndefined()
  expect(binary.formats.every((f) => f === 1)).toBe(true)
  expect(binary.rows).toHaveLength(text.rows.length)
  for (const [r, row] of text.rows.entries()) {
    for (const [c, value] of row.entries()) {
      const got = binary.rows[r]![c]!
      const type = binary.types[c]!
      if (value === null) expect(got, `${sql} [${r}][${c}]`).toBeNull()
      // A json value Sosie faked is its own text, not jsonb's canonical form: the same JSON, spaced its own way.
      else if (type === JSONB && !exactJson) expect(JSON.parse(got.subarray(1).toString())).toEqual(JSON.parse(value.toString()))
      else expect(got.toString('hex'), `${sql} [${r}][${c}] type ${type}: ${value.toString()}`).toBe(await postgresSends(type, value.toString()))
    }
  }
  return { text, binary }
}

describe('binary results', () => {
  it('sends every type it reads as Postgres sends it: constants, which pass', async () => {
    await asPostgresSends(`SELECT
      1::int2, -2::int4, 9223372036854775807::int8, 4294967295::oid, '7'::xid,
      1.5::float4, 0.1::float4, -2.25::float8, 'NaN'::float8, '-Infinity'::float8, '-0'::float8, 1e-7::float8, 1.5e300::float8,
      12345.678, -0.0012, 0::numeric(5,2), 10000::numeric, 0.00001234, 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric,
      true, false, 'Zürich 🏔'::text, 'é'::varchar(4), 'ab'::char(4), 'n'::name, 'q'::"char", '\\200'::"char",
      '\\x0102ff'::bytea, ''::bytea,
      '2026-11-04'::date, '0044-03-15 BC'::date, 'infinity'::date, '1999-12-31'::date,
      '12:34:56.789'::time, '24:00:00'::time, '12:34:56+05:30'::timetz, '23:00:00-03'::timetz,
      '2026-11-04 12:34:56.789012'::timestamp, '0044-03-15 12:00:00 BC'::timestamp, '-infinity'::timestamp,
      '2026-11-04 12:34:56+01'::timestamptz, '1969-07-20 20:17:40.5-05'::timestamptz,
      '1 year 2 mons -3 days 04:05:06.7'::interval, '-1 days -00:00:01'::interval, '00:00:00'::interval, '100 hours'::interval,
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid, '{"a": [1, "x"]}'::json, '{"b": 2, "a": 1}'::jsonb,
      '192.168.0.1/24'::inet, '192.168.0.1'::inet, '::ffff:1.2.3.4'::inet, '2001:db8::1'::inet, 'fe80::1:0:0:0'::inet,
      '2001:db8::/32'::cidr, '10.0.0.0/8'::cidr, '16/B374D848'::pg_lsn, '1 2'::int2vector, '23 25'::oidvector,
      ARRAY[1, 2, NULL]::int4[], '{{a,b},{"c d",""}}'::text[], '[0:1]={5,6}'::int8[], '{}'::text[],
      '{2026-11-04,infinity}'::date[], '{1.5,NaN}'::numeric[], '{t,f}'::bool[], ARRAY['2026-11-04 12:00:00+01']::timestamptz[],
      '{"1 day"}'::interval[], ARRAY['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']::uuid[], ARRAY['{"a": 1}']::jsonb[],
      '{"\\\\x01"}'::bytea[], '{"10.0.0.1/8"}'::inet[], B'10110'::bit(5), B'1'::bit, B''::varbit, B'101100111'::varbit,
      '{101,1}'::varbit[]`)
  })

  it('sends the fakes of every column of the seed as Postgres would send them', async () => {
    // Ranges are not written in binary: memberships' other columns are.
    const memberships = '(SELECT id, user_id, code, role, labels, roles, lasts, flags, mask FROM memberships) AS memberships'
    for (const table of ['users', 'orders', 'events', 'countries', 'billing.invoices', memberships]) {
      const { binary } = await asPostgresSends(`SELECT * FROM ${table} ORDER BY 1`, { exactJson: false })
      expect(binary.rows.length, table).toBeGreaterThan(0)
      expect(canariesIn(JSON.stringify(binary.rows.map((row) => row.map((v) => v?.toString('utf8')))))).toEqual([])
    }
  })

  it('sends text and binary columns side by side, as Bind asks', async () => {
    const result = await extended(port, 'SELECT id, email FROM users ORDER BY id', { resultFormats: [1, 0] })
    expect(result.formats).toEqual([1, 0])
    expect(result.rows[0]![0]).toHaveLength(4)
    expect(result.rows[0]![1]!.toString()).toMatch(/@/)
  })

  it('ends the statement, once upstream has, when a value is not in the text it reads', async () => {
    // A DateStyle of the client's own: dates come as 21/05/1988, which Sosie does not read as a date.
    const result = await extended(port, 'SELECT born_on FROM users WHERE born_on IS NOT NULL ORDER BY id', {
      before: "SET DateStyle = 'SQL, DMY'",
      resultFormats: [1],
    })
    expect(result.error).toMatchObject({ code: '22P03', message: expect.stringMatching(/column "born_on"/) })
    expect(result.rows).toEqual([])
  })

  it('refuses, as Postgres would, a type it cannot write from text, and a count of formats that does not match', async () => {
    const regclass = await extended(port, `SELECT 'pg_class'::regclass`, { resultFormats: [1] })
    expect(regclass.error).toMatchObject({ code: '0A000', message: expect.stringMatching(/cannot send column "regclass" \(regclass\) in binary/) })
    expect((await extended(port, `SELECT 'pg_class'::regclass`, { resultFormats: [0] })).rows[0]![0]!.toString()).toBe('pg_class')
    const formats = await extended(port, 'SELECT 1, 2', { resultFormats: [1, 1, 1] })
    expect(formats.error).toMatchObject({ code: '08P01' })
    expect((await extended(port, 'SELECT 1', { resultFormats: [2] })).error).toMatchObject({ code: '22023' })
  })
})

describe('binary parameters', () => {
  const int4 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeInt32BE(n)
    return b
  }

  it('turns a fake sent in binary back into the real value, with its type declared or not', async () => {
    const [[id, email]] = (await extended(port, 'SELECT id, email FROM users ORDER BY id LIMIT 1', { resultFormats: [0] })).rows.map((r) =>
      r.map((v) => v!.toString()),
    ) as [[string, string]]
    const sql = 'SELECT email FROM users WHERE id = $1'
    // Undeclared, as asyncpg leaves it until Describe: Sosie asks upstream for the type.
    const undeclared = await extended(port, sql, { params: [{ value: int4(Number(id)), format: 1 }], resultFormats: [0] })
    expect(undeclared.rows.map((r) => r[0]!.toString())).toEqual([email])
    const declared = await extended(port, sql, { params: [{ value: int4(Number(id)), format: 1 }], paramTypes: [23], resultFormats: [1] })
    expect(declared.rows.map((r) => r[0]!.toString())).toEqual([email])
    // An array of fakes, as = ANY($1) sends it: one dimension, no nulls, int4, one element from 1.
    const array = Buffer.concat([int4(1), int4(0), int4(23), int4(1), int4(1), int4(4), int4(Number(id))])
    const any = await extended(port, 'SELECT email FROM users WHERE id = ANY($1)', { params: [{ value: array, format: 1 }], resultFormats: [0] })
    expect(any.rows.map((r) => r[0]!.toString())).toEqual([email])
  })

  it('sends a binary parameter that holds no fake as the client sent it', async () => {
    const result = await extended(port, 'SELECT $1::int4 + 1 AS n', { params: [{ value: int4(41), format: 1 }], resultFormats: [0] })
    expect(result.error).toBeUndefined()
    expect(result.rows).toHaveLength(1)
  })
})

describe('what asyncpg runs around reading the catalog', () => {
  it('turns jit off with set_config written in the query, and back with a parameter', async () => {
    const off = await extended(port, "SELECT current_setting('jit') AS cur, set_config('jit', 'off', false) AS new", { resultFormats: [1] })
    expect(off.error).toBeUndefined()
    expect(off.rows[0]![1]!.toString()).toBe('off')
    const back = await extended(port, "SELECT set_config('jit', $1, false)", { params: [{ value: Buffer.from('on'), format: 0 }], resultFormats: [1] })
    expect(back.error).toBeUndefined()
    expect(back.rows[0]![0]!.toString()).toBe('on')
    // One Sosie checks, from a parameter, it cannot check: refused.
    const timeout = await extended(port, "SELECT set_config('statement_timeout', $1, false)", { params: [{ value: Buffer.from('0'), format: 0 }] })
    expect(timeout.error).toMatchObject({ code: '42501' })
  })
})
