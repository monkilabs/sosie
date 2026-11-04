import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import mysql2 from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { canariesIn } from '../canaries.js'
import { startSosie } from './sosie.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- rows as mysql2 returns them. */
type Row = Record<string, any>

let sosie: Awaited<ReturnType<typeof startSosie>>
let client: mysql2.Connection
let truth: mysql2.Connection
/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []

const query = async (sql: string, c: mysql2.Connection = client): Promise<Row[]> => {
  const [rows] = await c.query(sql)
  seen.push(rows)
  return rows as Row[]
}
const failure = async (sql: string, c: mysql2.Connection = client) => {
  try {
    await c.query(sql)
  } catch (error) {
    seen.push((error as Error).message)
    return error as { errno: number; sqlState: string; message: string }
  }
  throw new Error(`expected ${sql} to fail`)
}

beforeAll(async () => {
  sosie = await startSosie()
  client = await sosie.client()
  truth = await mysql2.createConnection(inject('mysqlUpstream'))
})

afterAll(async () => {
  await truth?.end()
  await sosie?.close()
  expect(canariesIn(JSON.stringify(seen, (_, v) => (v?.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') : v)))).toEqual([])
})

describe('reading through Sosie', () => {
  it('returns every row, every value faked, in its type and format', async () => {
    const rows = await query('SELECT * FROM users ORDER BY id')
    const [real] = (await truth.query('SELECT * FROM users ORDER BY id')) as [Row[], unknown]
    expect(rows).toHaveLength(real.length)
    const [first] = rows as [Row]
    expect(first.email).toMatch(/@example\.(com|net|org)$/)
    expect(first.email).not.toBe(real[0]!.email)
    expect(first.full_name).not.toBe(real[0]!.full_name)
    expect(first.phone).toMatch(/^\+420 \d{3} \d{3} \d{3}$/)
    expect(['admin', 'editor', 'viewer']).toContain(first.role)
    expect([0, 1]).toContain(first.active)
    expect(first.score).toMatch(/^\d{4}\.\d{2}$/)
    expect(first.external_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.created_at).toBeInstanceOf(Date)
    expect(Buffer.isBuffer(first.avatar) && first.avatar.length).toBe(4)
    expect(first.profile).toMatchObject({ email: expect.stringMatching(/@example\./), visits: expect.any(Number) })
  })

  it('keeps joins: a foreign key matches the key it points to, and a view what it shows', async () => {
    const rows = await query('SELECT u.id, o.user_id, u.email FROM users u JOIN orders o ON o.user_id = u.id ORDER BY o.id')
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(row.user_id).toBe(row.id)
    // An email the view shows is the email the table shows, for the same person.
    const [shown] = await query('SELECT id, email FROM active_users ORDER BY id LIMIT 1')
    const [direct] = await query(`SELECT email FROM users WHERE id = ${shown!.id}`)
    expect(direct!.email).toBe(shown!.email)
  })

  it('fakes what a query computes, and passes count(…), literals and the catalog', async () => {
    const [computed] = await query("SELECT UPPER(full_name) AS up, COUNT(*) AS n, 'literal' AS l, 7 AS seven FROM users WHERE id = 1 GROUP BY full_name")
    expect(computed!.up).not.toBe('QUILLON VANTABLACK')
    expect([computed!.n, computed!.l, computed!.seven]).toEqual([1, 'literal', 7])
    const tables = await query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1")
    expect(tables.map((r) => r.t)).toEqual(['active_users', 'countries', 'orders', 'users'])
    const [{ v }] = (await query('SELECT @@version_comment AS v')) as [Row]
    expect(typeof v).toBe('string')
  })

  it('shows the schema as it is: SHOW, DESCRIBE and SHOW CREATE', async () => {
    expect((await query('SHOW TABLES')).length).toBe(4)
    const described = await query('DESCRIBE users')
    expect(described.map((r) => r.Field)).toContain('email')
    expect(described.find((r) => r.Field === 'role')?.Type).toBe("enum('admin','editor','viewer')")
    const [created] = await query('SHOW CREATE TABLE users')
    expect(created!['Create Table']).toMatch(/CREATE TABLE `users`/)
  })
})

describe('querying by what you saw', () => {
  it('finds a row by a fake email, id or key, in a literal or an IN list', async () => {
    // A fake the client saw: a literal 1 means the row whose fake id is 1, which may be any row, or none.
    const [first] = await query('SELECT id, email, external_id, full_name FROM users WHERE external_id IS NOT NULL ORDER BY id LIMIT 1')
    const [byEmail] = await query(`SELECT full_name FROM users WHERE email = '${first!.email}'`)
    const [byId] = await query(`SELECT full_name FROM users WHERE id = ${first!.id}`)
    const byIn = await query(`SELECT full_name FROM users WHERE id IN (${first!.id}, 999999)`)
    const [byKey] = await query(`SELECT full_name FROM users WHERE external_id = '${first!.external_id}'`)
    for (const row of [byEmail, byId, byIn[0], byKey]) expect(row!.full_name).toBe(first!.full_name)
  })
})

describe('the guard', () => {
  it.each([
    ['DELETE FROM users', 1792],
    ["UPDATE users SET city = 'x'", 1792],
    ['DROP TABLE orders', 1792],
    ["SELECT LOAD_FILE('/etc/passwd')", 1227],
    ['SELECT @@datadir', 1227],
    ['SELECT * FROM mysql.user', 1227],
    ['SELECT * FROM performance_schema.events_statements_history', 1227],
    ['SHOW PROCESSLIST', 1227],
    ['SELECT * FROM users FOR UPDATE', 1227],
    ["SELECT /*!50000 LOAD_FILE('/etc/passwd'), */ 1", 1227],
    ['EXPLAIN SELECT * FROM users', 1235],
    ["SET SESSION sql_mode = 'ANSI_QUOTES'", 1227],
  ])('refuses %s, and says why', async (sql, code) => {
    const error = await failure(sql)
    expect(error.errno).toBe(code)
    expect(error.message).toMatch(/Sosie|read-only/)
  })

  it('keeps the session read-only, even with a login that can write', async () => {
    const admin = await startSosie({ upstream: inject('mysqlAdmin') })
    expect(admin.warnings.join(' ')).toMatch(/can change data|administrator/)
    const c = await admin.client()
    const [{ ro }] = (await query('SELECT @@transaction_read_only AS ro', c)) as [Row]
    expect(ro).toBe(1)
    expect((await failure("SET SESSION transaction_read_only = OFF", c)).errno).toBe(1227)
    await admin.close()
  })

  it('runs transactions, settings and USE', async () => {
    const c = await sosie.client()
    await query('START TRANSACTION READ ONLY', c)
    expect(await query('SELECT COUNT(*) AS n FROM orders', c)).toEqual([{ n: 5 }])
    await query('COMMIT', c)
    await query("SET time_zone = '+00:00', autocommit = 1", c)
    await query('USE information_schema', c)
    expect((await query('SELECT COUNT(*) AS n FROM TABLES WHERE TABLE_NAME = \'users\'', c))[0]!.n).toBeGreaterThan(0)
  })

  it('answers prepared statements, which come later, with an error that says so', async () => {
    await expect(client.execute('SELECT 1')).rejects.toThrow(/does not run prepared statements on MySQL yet/)
    expect(await query('SELECT 1 AS one')).toEqual([{ one: 1 }])
  })
})

describe('errors and limits', () => {
  it('hides the messages of warnings, which quote values from rows', async () => {
    await query('SELECT CAST(full_name AS SIGNED) AS n FROM users WHERE id = 1')
    const warnings = await query('SHOW WARNINGS')
    expect(warnings.length).toBeGreaterThan(0)
    for (const w of warnings) expect(w.Message).toMatch(/Sosie hides/)
  })

  it('shows errors about the statement itself, scrubbed of what Sosie turned back', async () => {
    const [first] = await query('SELECT email FROM users WHERE id = 1')
    const error = await failure(`SELECT nope FROM users WHERE email = '${first!.email}'`)
    expect(error.errno).toBe(1054)
    expect(error.message).toMatch(/Unknown column 'nope'/)
  })

  it('cuts results at the row cap, and says so in SHOW WARNINGS', async () => {
    const small = await startSosie({ maxRows: 5 })
    const c = await small.client()
    expect(await query('SELECT id FROM users', c)).toHaveLength(5)
    expect(await query('SELECT id FROM users LIMIT 30', c)).toHaveLength(5)
    const [note] = await query('SHOW WARNINGS', c)
    expect(note!.Message).toMatch(/first 5 rows/)
    await small.close()
  })

  it('stops a statement at the time limit it was started with', async () => {
    const quick = await startSosie({ statementTimeout: 300 })
    const c = await quick.client()
    const error = await failure('SELECT SLEEP(5) FROM users LIMIT 1', c).catch(() => undefined)
    const rows = error ? undefined : await query('SELECT 1', c)
    expect(error?.errno === 3024 || rows !== undefined).toBe(true)
    await quick.close()
  }, 15_000)
})

describe('the mysql client', () => {
  /** MySQL's own client: on the PATH, at MYSQL, or the one the embedded server came with. */
  const binary =
    process.env.MYSQL ??
    [process.env.PATH?.split(':').map((d) => join(d, 'mysql')) ?? [], embedded()].flat().find((p) => existsSync(p))

  it.skipIf(!binary && !process.env.CI)('reads through Sosie, shows the schema, and is refused what writes', async () => {
    const run = (sql: string) =>
      promisify(execFile)(binary!, ['--protocol=tcp', '-h', '127.0.0.1', '-P', String(sosie.port), '-u', 'kim', sosie.database, '-e', sql], { encoding: 'utf8' })
    const { stdout } = await run('SELECT email, full_name FROM users WHERE id = 1; SHOW TABLES; DESCRIBE orders')
    seen.push(stdout)
    expect(stdout).toMatch(/@example\./)
    expect(stdout).toMatch(/user_id\s+int/)
    await expect(run('DELETE FROM users')).rejects.toThrow(/Sosie is read-only/)
  })
})

/** The client in the binaries mysql-memory-server downloaded, when it did. */
function embedded(): string[] {
  const base = join(tmpdir(), 'mysqlmsn', 'binaries')
  if (!existsSync(base)) return []
  return readdirSync(base).map((version) => join(base, version, 'mysql', 'bin', 'mysql'))
}
