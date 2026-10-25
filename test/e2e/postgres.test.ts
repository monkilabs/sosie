import { connect } from 'node:net'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { canariesIn } from './canaries.js'
import { real, startSosie, type Started } from './sosie.js'

/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []
let sosie: Started
let client: pg.Client
let truth: pg.Client

const query = async (text: string, values?: unknown[]) => {
  const result = await client.query(text, values)
  seen.push(result.rows)
  return result.rows
}

const failure = async (text: string, values?: unknown[]): Promise<{ code?: string; message: string; position?: string }> => {
  try {
    await client.query(text, values)
  } catch (error) {
    seen.push((error as Error).message)
    return error as { code?: string; message: string; position?: string }
  }
  throw new Error(`expected ${text} to fail`)
}

beforeAll(async () => {
  sosie = await startSosie()
  client = await sosie.client()
  truth = await real()
})

afterAll(async () => {
  await truth.end()
  await sosie.close()
})

describe('reading through Sosie', () => {
  it('returns every row, every value faked', async () => {
    const rows = await query('SELECT * FROM users ORDER BY id')
    const { rows: realRows } = await truth.query('SELECT * FROM users ORDER BY id')
    expect(rows).toHaveLength(realRows.length)
    expect(rows[0].email).toMatch(/@example\.(com|net|org)$/)
    expect(rows[0].email).not.toBe(realRows[0].email)
    expect(rows[0].full_name).not.toBe(realRows[0].full_name)
  })

  it('keeps types and formats', async () => {
    const [first] = await query('SELECT * FROM users WHERE external_id IS NOT NULL ORDER BY id LIMIT 1')
    expect(first.phone).toMatch(/^\+420 \d{3} \d{3} \d{3}$/)
    expect(first.api_key).toMatch(/^[a-z]{2}_[a-z]{4}_\w{12}$/)
    expect(first.account).toMatch(/^[1-9]\d{9}$/)
    expect(first.created_at).toBeInstanceOf(Date)
    expect(first.score).toMatch(/^\d{4}\.\d{2}$/)
    expect(first.external_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.last_ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/)
    expect(first.avatar).toHaveLength(4)
    expect(first.tags).toHaveLength(3)
    expect(first.tags[2]).toBeNull()
    expect(Object.keys(first.profile)).toEqual(['vip', 'email', 'visits', 'address', 'nickname'])
    expect(first.profile.email).toBe(first.email)
    expect(['admin', 'editor', 'viewer']).toContain(first.role)
    expect(first.country).toHaveLength(2)
  })

  it('returns values with nothing to fake as they are, and goes on', async () => {
    const rows = await query(`SELECT city, api_key, score, born_on::text AS born, profile, coalesce(NULL, '') AS blank FROM users WHERE api_key = ''`)
    // city is a format by its name, so even '-' becomes a city; the rest hold nothing to fake.
    expect(rows).toEqual([
      { city: expect.any(String), api_key: '', score: 'NaN', born: 'infinity', profile: { note: '', tags: ['...'] }, blank: '' },
    ])
    expect((await query('SELECT 1 AS ok'))[0].ok).toBe(1)
  })

  it('keeps joins: a foreign key matches the key it points to', async () => {
    const rows = await query('SELECT u.id AS uid, o.user_id, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id')
    for (const row of rows) expect(row.user_id).toBe(row.uid)
    const users = await query('SELECT id FROM users')
    const orders = await query('SELECT user_id FROM orders')
    const ids = new Set(users.map((u) => u.id))
    for (const o of orders) expect(ids.has(o.user_id)).toBe(true)
    const invoices = await query('SELECT order_id FROM billing.invoices')
    const orderIds = new Set((await query('SELECT id FROM orders')).map((o) => o.id))
    for (const i of invoices) expect(orderIds.has(i.order_id)).toBe(true)
  })

  it('gives a view the same fakes as its table', async () => {
    const view = await query('SELECT id, email, full_name FROM active_users ORDER BY id')
    const table = await query('SELECT id, email, full_name FROM users WHERE active ORDER BY id')
    expect(view).toEqual(table)
  })

  it('passes count(…), and the catalogs', async () => {
    const [{ count }] = await query('SELECT count(*) FROM users')
    const [{ count: realCount }] = (await truth.query('SELECT count(*) FROM users')).rows
    expect(count).toBe(realCount)
    const byStatus = await query('SELECT status, count(*) AS n FROM orders GROUP BY status')
    expect(byStatus.reduce((sum, r) => sum + Number(r.n), 0)).toBe(5)
    const columns = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position`)
    expect(columns.map((c) => c.column_name).slice(0, 3)).toEqual(['id', 'email', 'full_name'])
    const [relation] = await query(`SELECT relname FROM pg_class WHERE relname = 'orders'`)
    expect(relation.relname).toBe('orders')
    const [{ version }] = await query('SELECT version()')
    expect(version).toMatch(/^PostgreSQL/)
  })

  it('fakes every column of a UNION, whatever its first arm selects', async () => {
    const rows = await query('SELECT count(*) FROM orders UNION ALL SELECT id FROM users')
    const realRows = (await truth.query('SELECT count(*) FROM orders UNION ALL SELECT id FROM users')).rows
    expect(rows.map((r) => r.count)).not.toEqual(realRows.map((r) => r.count))
  })

  it('fakes what a query computes', async () => {
    const rows = await query('SELECT upper(full_name) AS name, length(email) AS n, user_email(id) AS e FROM users')
    expect(rows.length).toBeGreaterThan(2)
    const [direct] = await query('SELECT user_email(1) AS e')
    expect(direct.e).not.toBe('quill.vantablack@canary-mail.test')
  })

  it('fakes JSON built from rows, keys included', async () => {
    const [{ map }] = await query('SELECT json_object_agg(email, full_name) AS map FROM users WHERE email IS NOT NULL')
    expect(Object.keys(map)).toHaveLength(40)
    const [{ doc }] = await query('SELECT jsonb_build_object(full_name, email, \'id\', id) AS doc FROM users ORDER BY id LIMIT 1')
    expect(Object.keys(doc)).toContain('id')
  })

  it('fakes keys a query builds from rows, and keys a json column holds data in', async () => {
    await query('SELECT json_object_agg(city, id) AS by_city, json_object_agg(api_key, id) AS by_key FROM users WHERE api_key <> \'\'')
    await query('SELECT profile FROM users WHERE id IN (1, 2, 3)')
  })

  it('fakes what user-defined operators return', async () => {
    const [{ e }] = await query('SELECT 1 ### 2 AS e')
    expect(e).not.toBe('quill.vantablack@canary-mail.test')
  })

  it('does not count rows any set-returning function made from a value', async () => {
    const [{ count }] = await query(
      "SELECT count(*) FROM (SELECT ts_parse('default', repeat('a ', score::int)) FROM users WHERE external_id = 'd3adb33f-0000-4000-8000-c0ffee000001') s",
    )
    expect(count).not.toBe('2470')
  })

  it('does not count rows a value made', async () => {
    const [{ count }] = await query(
      "SELECT count(*) FROM generate_series(1, (SELECT (score * 100)::int FROM users WHERE external_id = 'd3adb33f-0000-4000-8000-c0ffee000001'))",
    )
    expect(count).not.toBe('123456')
  })

  it('runs several statements in one query, and transactions', async () => {
    const results = (await client.query('SELECT 1 AS one; SELECT count(*) FROM orders')) as unknown as pg.QueryResult[]
    expect(results.map((r) => r.rows[0])).toEqual([{ one: 1 }, { count: '5' }])
    await client.query('BEGIN')
    expect((await query('SELECT count(*) FROM orders'))[0].count).toBe('5')
    await client.query('COMMIT')
    expect((await client.query('')).rows).toEqual([])
  })
})

describe('querying by what you saw', () => {
  it('finds a row by a fake email, id or key in a literal', async () => {
    const [first] = await query('SELECT id, email, full_name FROM users WHERE external_id IS NOT NULL ORDER BY id LIMIT 1')
    expect(await query(`SELECT id, full_name FROM users WHERE email = '${first.email}'`)).toEqual([{ id: first.id, full_name: first.full_name }])
    expect(await query(`SELECT email FROM users u WHERE u.id = ${first.id}`)).toEqual([{ email: first.email }])
    const orders = await query(`SELECT count(*) FROM orders WHERE user_id = ${first.id}`)
    expect(orders[0].count).toBe('2')
    expect(await query(`SELECT id FROM users WHERE id IN (${first.id}, -1)`)).toEqual([{ id: first.id }])
  })

  it('finds rows by fakes in parameters, IN lists and arrays', async () => {
    const people = await query('SELECT id, email FROM users ORDER BY id LIMIT 3')
    expect(await query('SELECT email FROM users WHERE id = $1', [people[1].id])).toEqual([{ email: people[1].email }])
    expect(await query('SELECT id FROM users WHERE email = $1', [people[2].email])).toEqual([{ id: people[2].id }])
    const many = await query('SELECT id FROM users WHERE id = ANY($1) ORDER BY id', [people.map((p) => p.id)])
    expect(many).toHaveLength(3)
    const listed = await query(`SELECT id FROM users WHERE id = ANY('{${people[0].id},${people[1].id}}')`)
    expect(listed).toHaveLength(2)
  })

  it('finds rows by a faked enum label and boolean', async () => {
    const orders = await query('SELECT id, status FROM orders')
    const status = orders[0].status
    const same = orders.filter((o) => o.status === status).map((o) => o.id).sort()
    expect((await query('SELECT id FROM orders WHERE status = $1', [status])).map((o) => o.id).sort()).toEqual(same)
    const users = await query('SELECT id, active FROM users')
    const active = users.filter((u) => u.active).length
    expect(await query('SELECT id FROM users WHERE active = true')).toHaveLength(active)
  })
})

describe('the guard', () => {
  it.each([
    ["INSERT INTO countries VALUES ('PL', 'Poland')", '25006'],
    ["UPDATE users SET full_name = 'x'", '25006'],
    ['DELETE FROM orders', '25006'],
    ['TRUNCATE events', '25006'],
    ['CREATE TABLE t (id int)', '25006'],
    ['DROP TABLE events', '25006'],
    ['WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone', '25006'],
    ['SELECT * INTO copy FROM users', '25006'],
    ['SELECT * FROM users FOR UPDATE', '25006'],
    ['SET default_transaction_read_only = off', '42501'],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', '25006'],
    ['BEGIN READ WRITE', '25006'],
    ['SET ROLE postgres', '42501'],
    ["SELECT set_config('default_transaction_read_only', 'off', false)", '42501'],
    ["SELECT set_config('app.v', email, false) FROM users WHERE id = 1", '42501'],
    ['SHOW port', '42501'],
    ["SELECT name, setting FROM pg_settings WHERE name = 'port'", '42501'],
    ['SELECT last_value FROM pg_sequences', '42501'],
    ['SELECT * FROM information_schema.foreign_server_options', '42501'],
    ['RESET transaction_read_only', '42501'],
    ["SET statement_timeout = '1h'", '42501'],
    ['EXPLAIN SELECT * FROM users', '0A000'],
    ['SELECT * FROM pg_stats', '42501'],
    ['SELECT * FROM pg_catalog.pg_stat_activity', '42501'],
    ['SELECT inet_server_addr()', '42501'],
    ["SELECT query_to_xml('SELECT * FROM users', true, false, '')", '42501'],
    ["SELECT * FROM ts_stat('SELECT to_tsvector(full_name) FROM users')", '42501'],
    ['COPY users TO STDOUT', '0A000'],
    ['LISTEN news', '0A000'],
  ])('refuses %s', async (sql, code) => {
    const error = await failure(sql)
    expect(error.code).toBe(code)
    // A refusal stops nothing else: the session goes on.
    expect((await query('SELECT 1 AS ok'))[0].ok).toBe(1)
  })

  it('explains a refusal', async () => {
    expect((await failure('DELETE FROM orders')).message).toBe('This statement changes data. Sosie is read-only.')
    expect((await failure('SELECT * FROM pg_stats')).message).toBe('pg_stats holds real values from your tables, so Sosie does not read it.')
  })

  it('refuses in the extended protocol too, and recovers', async () => {
    expect((await failure('DELETE FROM orders WHERE id = $1', [1])).code).toBe('25006')
    expect(await query('SELECT count(*) FROM orders WHERE id = $1', [-1])).toEqual([{ count: '0' }])
  })

  it('allows reads, settings and transactions', async () => {
    await client.query("SET statement_timeout = '2s'")
    await client.query('SET application_name = test')
    expect((await query('SHOW statement_timeout'))[0].statement_timeout).toBe('2s')
    await client.query('RESET ALL')
    await client.query('BEGIN READ ONLY')
    await client.query('ROLLBACK')
  })

  it('keeps the session read-only for what the guard lets through, even with a login that can write', async () => {
    const writer = await startSosie({ upstream: new URL(inject('admin')) })
    expect(writer.warnings).toEqual([
      'The login is a superuser or can replicate. Sosie refuses the admin functions it knows, but a read-only login is safer.',
      "The login can write to 5 tables. Sosie's session is read-only, but a read-only login is safer.",
    ])
    const c = await writer.client()
    const fail = (sql: string) => c.query(sql).catch((e: { code: string; message: string }) => e)
    expect(await fail("SELECT nextval('users_id_seq')")).toMatchObject({ code: '25006', message: 'cannot execute nextval() in a read-only transaction' })
    // Inside a function, so its text is hidden; the code says what stopped it.
    expect(await fail('SELECT touch_user(1)')).toMatchObject({ code: '25006' })
    for (const sql of [
      "SELECT pg_create_physical_replication_slot('sosie_test', true)",
      'SELECT pg_switch_wal()',
      'SELECT pg_reload_conf()',
      'SELECT pg_stat_reset()',
      "SELECT pg_notify('news', 'x')",
      'SELECT pg_advisory_lock(42)',
      "SELECT lo_from_bytea(0, 'x')",
    ]) {
      expect(await fail(sql)).toMatchObject({ code: '25006', message: expect.stringMatching(/it changes the server\. Sosie is read-only\.$/) })
    }
    expect(sosie.warnings).toEqual([])
    await writer.close()
  })

  it('aborts the transaction it refuses a statement in, as Postgres does', async () => {
    const c = await sosie.client()
    await c.query('BEGIN')
    expect((await c.query('SELECT count(*) FROM users')).rows[0].count).toBe('40')
    await expect(c.query('DELETE FROM users')).rejects.toMatchObject({ code: '25006' })
    await expect(c.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
    expect((await c.query('COMMIT')).command).toBe('ROLLBACK')
    expect((await c.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }])
  })

  it('keeps the settings that decide how a statement is read', async () => {
    for (const sql of ['SET standard_conforming_strings = off', "SET client_encoding = 'SJIS'", "SET NAMES 'LATIN1'"]) {
      expect((await failure(sql)).code).toBe('42501')
    }
    expect((await failure("SELECT set_config('standard_conforming_strings', 'off', false)")).code).toBe('42501')
    await client.query("SET client_encoding = 'UTF8'")
    // Read with standard_conforming_strings off, this would hide a subquery inside what looks like strings.
    await query("SELECT 'a\\'', (SELECT email FROM users ORDER BY id LIMIT 1) AS e, '--'")
  })

  it('reads statements the same way when the login defaults to standard_conforming_strings off', async () => {
    const admin = await real()
    const role = `sosie_scs_${process.pid}`
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'scs'; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON users TO ${role};
      ALTER ROLE ${role} SET standard_conforming_strings = off`)
    try {
      const upstream = new URL(inject('admin'))
      upstream.username = role
      upstream.password = 'scs'
      const odd = await startSosie({ upstream })
      const c = await odd.client()
      expect((await c.query('SHOW standard_conforming_strings')).rows).toEqual([{ standard_conforming_strings: 'on' }])
      const rows = (await c.query("SELECT 'a\\'', (SELECT email FROM users ORDER BY id LIMIT 1) AS e, '--'")).rows
      seen.push(rows)
      await odd.close()
    } finally {
      await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`)
      await admin.end()
    }
  })

  it('closes a connection that sends a malformed message, and serves the others', async () => {
    const port = Number(new URL(sosie.address).port)
    for (const bytes of [[0, 0, 0, 4], [0, 0, 0, 8, 4, 210, 22, 46], [0, 0, 0, 9, 0, 3, 0, 0, 117]]) {
      await new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.from(bytes)))
        socket.on('close', () => resolve())
        socket.on('error', () => resolve())
        setTimeout(() => socket.destroy(), 500)
      })
    }
    expect((await query('SELECT 1 AS ok'))[0].ok).toBe(1)
  })
})

describe('errors and limits', () => {
  it('scrubs errors of real values', async () => {
    // Raised while reading rows: only the code and what it means come back.
    const error = await failure('SELECT full_name::int FROM users')
    expect(error.code).toBe('22P02')
    expect(error.message).toBe('invalid text representation (22P02): Sosie hides the rest of this message, which may quote a value from your rows.')
    // Raised before any row is read: the message comes back, scrubbed.
    expect((await failure("SELECT 'x'::int")).message).toBe('invalid input syntax for type integer: "x"')
    const [first] = await query('SELECT email FROM users WHERE external_id IS NOT NULL ORDER BY id LIMIT 1')
    const substituted = await failure(`SELECT email::int FROM users WHERE email = '${first.email}'`)
    expect(substituted.message).not.toMatch(/canary/)
  })

  it('hides the text of errors and notices raised by functions, which may quote rows unquoted', async () => {
    const error = await failure('SELECT check_user(id) FROM users ORDER BY id LIMIT 1')
    expect(error.code).toBe('P0001')
    expect(error.message).toBe('A function in the database raised an error; Sosie hides its text, which may quote rows.')
    const notices: string[] = []
    const listen = (n: { message?: string }) => notices.push(n.message ?? '')
    client.on('notice', listen)
    await query('SELECT greet(id) FROM users ORDER BY id LIMIT 1')
    client.off('notice', listen)
    seen.push(notices)
    expect(notices).toEqual(['A function in the database sent a notice; Sosie hides its text, which may quote rows.'])
  })

  it('masks values Postgres prints unquoted in its errors', async () => {
    // The planted row, by its real uuid: an id like 1 may already be a fake that names another row.
    const planted = "external_id = 'd3adb33f-0000-4000-8000-c0ffee000001'"
    const date = await failure(`SELECT make_date(extract(year FROM born_on)::int, extract(month FROM born_on)::int + 12, 1) FROM users WHERE ${planted}`)
    expect(date.message).toMatch(/^datetime field overflow \(22008\): Sosie hides the rest/)
    const bit = await failure(`SELECT set_bit('\\x00'::bytea, account::bigint, 1) FROM users WHERE ${planted}`)
    expect(bit.message).toMatch(/: Sosie hides the rest of this message/)
    // Unquoted and without a digit: no pattern finds these, so no message read with rows comes back.
    for (const sql of [
      `SELECT city::regoper FROM users WHERE ${planted}`,
      `SELECT split_part(full_name, ' ', 2)::regoper FROM users WHERE ${planted}`,
      `SELECT email::regoper FROM users WHERE ${planted}`,
    ]) {
      expect((await failure(sql)).message).toMatch(/: Sosie hides the rest of this message/)
    }
  })

  it('reports syntax errors with their position', async () => {
    const error = await failure('SELEC 1')
    expect(error.code).toBe('42601')
    expect(error.message).toBe('syntax error at or near "SELEC"')
    expect(error.position).toBe('1')
    expect((await failure('SELECT nope FROM users')).message).toBe('column "nope" does not exist')
    const hinted = (await failure('SELECT u.emial FROM users u')) as { hint?: string }
    expect(hinted.hint).toBe('Perhaps you meant to reference the column "u.email".')
  })

  it('cuts results at the row cap, and says so', async () => {
    const notices: string[] = []
    client.on('notice', (n) => notices.push(n.message ?? ''))
    expect(await query('SELECT * FROM events')).toHaveLength(100)
    expect(await query('SELECT * FROM events WHERE id > $1', [0])).toHaveLength(100)
    expect(await query('SELECT * FROM events LIMIT 20')).toHaveLength(20)
    expect(notices.filter((n) => n.startsWith('Sosie returned the first 100 rows'))).toHaveLength(2)
  })

  it('stops a statement on cancel', async () => {
    const other = await sosie.client()
    const { processID, secretKey } = other as unknown as { processID: number; secretKey: number }
    const running = other.query('SELECT pg_sleep(3), count(*) FROM users').catch((e: { code: string }) => e)
    await new Promise((r) => setTimeout(r, 300))
    const port = Number(new URL(sosie.address).port)
    const request = Buffer.alloc(16)
    request.writeInt32BE(16, 0)
    request.writeInt32BE(80877102, 4)
    request.writeInt32BE(processID, 8)
    request.writeInt32BE(secretKey, 12)
    const socket = connect(port, '127.0.0.1', () => socket.end(request))
    expect(((await running) as { code: string }).code).toBe('57014')
  })
})

describe('a team that lets some values pass', () => {
  it('passes what sosie.yml lists, and the keys that point at it', async () => {
    const lenient = await startSosie({ rules: 'pass:\n  - countries.*\n  - orders.status\n' })
    const c = await lenient.client()
    const countries = (await c.query('SELECT code, name FROM countries ORDER BY code')).rows
    expect(countries).toEqual([
      { code: 'AT', name: 'Austria' },
      { code: 'CZ', name: 'Czechia' },
      { code: 'SK', name: 'Slovakia' },
    ])
    const statuses = (await c.query('SELECT DISTINCT status FROM orders ORDER BY status')).rows.map((r) => r.status)
    expect(statuses).toEqual(['new', 'paid', 'shipped', 'cancelled'])
    const users = (await c.query(`SELECT country FROM users WHERE country = 'CZ'`)).rows
    expect(users).toEqual([{ country: 'CZ' }])
    // A passing field in the first arm of a UNION lets nothing pass from the others.
    const mixed = (await c.query('SELECT name::text FROM countries UNION ALL SELECT full_name FROM users')).rows
    expect(mixed.length).toBeGreaterThan(40)
    seen.push(countries, statuses, users, mixed)
    await lenient.close()
  })

  it('gives the same fakes in the next session', async () => {
    const before = await query('SELECT id, email FROM users ORDER BY id')
    const again = await startSosie({ home: sosie.home })
    const c = await again.client()
    expect((await c.query('SELECT id, email FROM users ORDER BY id')).rows).toEqual(before)
    await again.close()
  })
})

describe('canaries', () => {
  it('never came out', () => {
    expect(canariesIn(JSON.stringify(seen))).toEqual([])
  })
})
