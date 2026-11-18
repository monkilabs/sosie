import { readFileSync } from 'node:fs'
import { Connection, TYPES } from 'tedious'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { canariesIn } from '../canaries.js'
import { ask, startSosie, type Answer, type Row } from './sosie.js'
import { connect } from './database.js'

const upstream = inject('sqlserverUpstream')

let sosie: Awaited<ReturnType<typeof startSosie>>
let client: Connection
let truth: Connection
/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []

const rows = async (sql: string, params?: Parameters<typeof ask>[2], c: Connection = client): Promise<Row[]> => {
  const answer = await ask(c, sql, params)
  seen.push(answer)
  if (answer.error) throw new Error(`${sql}: ${answer.error.message}`)
  return answer.sets[0] ?? []
}
const failure = async (sql: string, params?: Parameters<typeof ask>[2], c: Connection = client): Promise<NonNullable<Answer['error']>> => {
  const answer = await ask(c, sql, params)
  seen.push(answer)
  if (!answer.error) throw new Error(`expected ${sql} to fail`)
  return answer.error
}
const real = async (sql: string) => (await ask(truth, sql)).sets[0] ?? []

describe.skipIf(!upstream)('SQL Server through Sosie', () => {
  beforeAll(async () => {
    sosie = await startSosie()
    client = await sosie.client()
    truth = await connect(new URL(inject('sqlserverAdmin')))
  })

  afterAll(async () => {
    truth?.close()
    await sosie?.close()
    expect(canariesIn(JSON.stringify(seen, (_, v) => (v?.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') : v)))).toEqual([])
  })

  describe('reading', () => {
    it('returns every row, every value faked, in its type and format', async () => {
      const got = await rows('SELECT * FROM users ORDER BY id')
      const truths = await real('SELECT * FROM users ORDER BY id')
      expect(got).toHaveLength(truths.length)
      const [first] = got as [Row]
      expect(first.email).toMatch(/@example\.(com|net|org)$/)
      expect(first.email).not.toBe(truths[0]!.email)
      expect(first.full_name).not.toBe(truths[0]!.full_name)
      expect(first.phone).toMatch(/^\+420 \d{3} \d{3} \d{3}$/)
      expect(typeof first.active).toBe('boolean')
      expect(first.created_at).toBeInstanceOf(Date)
      expect(first.score).toEqual(expect.any(Number))
      expect(first.external_id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
      expect(first.avatar).toBeInstanceOf(Buffer)
      expect(first.avatar).toHaveLength(4)
      expect(first.country).toHaveLength(2)
    })

    it('fakes a value the same way everywhere: joins hold, and keys stay unique', async () => {
      const users = await rows('SELECT id, email FROM users ORDER BY id')
      const joined = await rows('SELECT u.id, u.email, o.total FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id')
      const byId = new Map(users.map((u) => [u.id, u.email]))
      for (const r of joined) expect(r.email).toBe(byId.get(r.id))
      expect(new Set(users.map((u) => u.id)).size).toBe(users.length)
      expect(new Set(users.map((u) => u.email)).size).toBe(users.length)
    })

    it('shows only the columns asked for: browse mode’s hidden keys never come back', async () => {
      const answer = await ask(client, 'SELECT email FROM users ORDER BY id; SELECT o.total FROM orders o JOIN users u ON u.id = o.user_id')
      seen.push(answer)
      expect(answer.sets).toHaveLength(2)
      expect(Object.keys(answer.sets[0]![0]!)).toEqual(['email'])
      expect(Object.keys(answer.sets[1]![0]!)).toEqual(['total'])
    })

    it('passes a count and a literal, and fakes what is computed from a row', async () => {
      const [r] = await rows("SELECT COUNT(*) AS n, COUNT_BIG(*) AS big, 'as written' AS said, MAX(total) AS highest, UPPER(MIN(email)) AS shouted FROM users u JOIN orders o ON o.user_id = u.id")
      expect(r).toMatchObject({ n: 5, big: '5', said: 'as written' })
      expect(r!.highest).not.toBe(1500)
      expect(r!.shouted).not.toMatch(/canary/i)
    })

    it('passes the catalog: sys views and INFORMATION_SCHEMA are the schema', async () => {
      const tables = await rows("SELECT name FROM sys.tables WHERE name IN ('users', 'orders') ORDER BY name")
      expect(tables).toEqual([{ name: 'orders' }, { name: 'users' }])
      const columns = await rows("SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'email'")
      expect(columns).toEqual([{ c: 'email' }])
    })

    it('fakes a view’s columns as its table’s', async () => {
      // An id in a WHERE is a fake, turned back: the view's own id finds the user's row in the table.
      const [viewed] = await rows('SELECT TOP 1 id, email FROM active_users ORDER BY id')
      const [table] = await rows(`SELECT email FROM users WHERE id = ${viewed!.id}`)
      expect(viewed!.email).toBe(table!.email)
    })

    it('fakes every type in its own type, and what it cannot fake (xml, geography, sql_variant) as null', async () => {
      const [k] = await rows('SELECT * FROM kinds')
      const [t] = await real('SELECT * FROM kinds')
      for (const [column, value] of Object.entries(k!)) {
        if (['x', 'g', 'h', 'v'].includes(column)) expect(value, column).toBeNull()
        else if (column !== 'id') expect(value, column).not.toBeNull()
      }
      expect(k!.t).toBeGreaterThanOrEqual(0)
      expect(k!.t).toBeLessThanOrEqual(255)
      expect(k!.c).toHaveLength(5)
      expect(k!.bn).toHaveLength(4)
      expect(k!.d).toBeInstanceOf(Date)
      expect(k!.dto).toBeInstanceOf(Date)
      expect(typeof k!.nvc).toBe('string')
      expect(k!.nvc).not.toBe(t!.nvc)
      expect(k!.vc.length).toBeGreaterThan(1000)
    })

    it('fakes FOR JSON as JSON, its values as the columns’ fakes', async () => {
      const answer = await ask(client, 'SELECT TOP 3 id, email FROM users ORDER BY id FOR JSON PATH')
      seen.push(answer)
      const text = answer.sets[0]!.map((r) => Object.values(r)[0]).join('')
      const parsed = JSON.parse(text) as { id: number; email: string }[]
      expect(parsed).toHaveLength(3)
      const emails = await rows('SELECT TOP 3 email FROM users ORDER BY id')
      expect(parsed.map((p) => p.email)).toEqual(emails.map((e) => e.email))
    })

    it('cuts a result at max-rows, and says so', async () => {
      const small = await startSosie({ maxRows: 5 })
      try {
        const c = await small.client()
        const answer = await ask(c, 'SELECT id FROM users')
        seen.push(answer)
        expect(answer.sets[0]).toHaveLength(5)
        expect(answer.infos.join('\n')).toContain('Sosie returned the first 5 rows')
      } finally {
        await small.close()
      }
    })
  })

  describe('finding rows by a fake', () => {
    it('turns a fake back in a literal, N or not, and in an IN list', async () => {
      const [{ email, phone }] = (await rows('SELECT email, phone FROM users WHERE id = 1')) as [Row]
      expect(await rows(`SELECT id FROM users WHERE email = N'${email}'`)).toEqual([{ id: (await rows('SELECT id FROM users WHERE id = 1'))[0]!.id }])
      expect(await rows(`SELECT COUNT(*) AS n FROM users WHERE phone = '${phone}'`)).toEqual([{ n: 1 }])
      expect(await rows(`SELECT COUNT(*) AS n FROM users WHERE email IN (N'${email}', N'nobody@example.com')`)).toEqual([{ n: 1 }])
    })

    it('turns a fake back in a parameter, as sp_executesql sends it, wider where the real value is longer', async () => {
      const [{ email, id }] = (await rows('SELECT email, id FROM users WHERE id = 1')) as [Row]
      expect(await rows('SELECT full_name FROM users WHERE email = @e', [['e', TYPES.NVarChar, email]])).toHaveLength(1)
      expect(await rows('SELECT email FROM users WHERE id = @id', [['id', TYPES.Int, id]])).toEqual([{ email }])
      // SqlClient sizes a parameter to its value: nvarchar(n) for an n-letter fake whose real value may be longer. The first
      // user by the real ids' order is the one in Vantaville; a literal id in a WHERE is a fake, turned back.
      const [{ city }] = (await rows('SELECT city FROM users ORDER BY id')) as [Row]
      const sized = await rows('SELECT COUNT(*) AS n FROM users WHERE city = @c', [['c', TYPES.NVarChar, city, { length: city.length }]])
      expect(sized).toEqual([{ n: 1 }])
    })

    it('turns a fake back in a prepared statement, each time it runs', async () => {
      const [{ email }] = (await rows('SELECT email FROM users WHERE id = 2')) as [Row]
      const { Request } = await import('tedious')
      const request = new Request('SELECT COUNT(*) AS n FROM users WHERE email = @e', () => {})
      request.addParameter('e', TYPES.NVarChar)
      await new Promise<void>((resolve, reject) => {
        request.once('prepared', () => resolve())
        request.once('error', reject)
        client.prepare(request)
      })
      for (let i = 0; i < 2; i++) {
        const counted: number[] = []
        request.on('row', (columns) => counted.push(columns[0].value))
        await new Promise<void>((resolve, reject) => {
          ;(request as unknown as { callback: (e?: Error) => void }).callback = (e) => (e ? reject(e) : resolve())
          client.execute(request, { e: email })
        })
        request.removeAllListeners('row')
        expect(counted).toEqual([1])
      }
    })
  })

  describe('refusing', () => {
    it.each([
      ["UPDATE users SET email = N'x'", 3906],
      ['DELETE FROM orders', 3906],
      ['INSERT INTO countries VALUES (N\'XX\', N\'x\')', 3906],
      ['SELECT email INTO #copy FROM users', 229],
      ['DROP TABLE orders', 3906],
      ['EXEC sp_who', 50000],
      ['SELECT @@SERVERNAME', 229],
      ["SELECT SERVERPROPERTY('MachineName')", 229],
      ['SELECT * FROM sys.dm_exec_sessions', 229],
      ['SELECT * FROM sys.sql_logins', 229],
      ["SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;Trusted_Connection=yes', 'SELECT 1') AS t", 229],
      ['SELECT * FROM msdb.dbo.sysjobs', 229],
      ['SELECT id FROM users FOR XML PATH', 50000],
      ['SET NO_BROWSETABLE OFF', 229],
      ['SET ROWCOUNT 0', 229],
      ['SELECT email FROM users WITH (UPDLOCK)', 229],
      ["PRINT 'hello'", 50000],
    ])('%s', async (sql, number) => {
      const error = await failure(sql)
      expect(error.number).toBe(number)
    })

    it('changes nothing upstream', async () => {
      await failure("UPDATE users SET email = N'changed' WHERE id = 1")
      expect((await real('SELECT email FROM users WHERE id = 1'))[0]!.email).toBe('quill.vantablack@canary-mail.test')
    })

    it('shows an error about the schema, and hides one that may quote a value', async () => {
      expect((await failure('SELECT emial FROM users')).message).toBe("Invalid column name 'emial'.")
      const hidden = await failure('SELECT CAST(email AS int) FROM users')
      expect(hidden.number).toBe(245)
      expect(hidden.message).toBe('Message 245: Sosie hides the rest of this message, which may quote a value from your rows.')
    })
  })

  describe('a session', () => {
    it('runs SET statements without semicolons, as tedious and ORMs send them', async () => {
      expect(await rows('SET NOCOUNT ON SET ANSI_WARNINGS ON SELECT 1 AS one')).toEqual([{ one: 1 }])
    })

    it('keeps browse mode after a reset, as a pool resets a session', async () => {
      await new Promise<void>((resolve, reject) => client.reset((e) => (e ? reject(e) : resolve())))
      const [first] = await rows('SELECT email FROM users ORDER BY id')
      expect(Object.keys(first!)).toEqual(['email'])
    })

    it('runs transactions, as drivers begin and end them', async () => {
      await new Promise<void>((resolve, reject) => client.beginTransaction((e) => (e ? reject(e) : resolve())))
      expect(await rows('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 5 }])
      await new Promise<void>((resolve, reject) => client.rollbackTransaction((e) => (e ? reject(e) : resolve())))
    })

    it('stops a statement at its time limit', async () => {
      const slow = await startSosie({ statementTimeout: 500 })
      try {
        const c = await slow.client()
        const error = await failure('SELECT COUNT_BIG(*) AS n FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c', undefined, c)
        expect(error.message).toContain('Sosie stopped the statement at its time limit')
        expect(await rows('SELECT 1 AS one', undefined, c)).toEqual([{ one: 1 }])
      } finally {
        await slow.close()
      }
    })

    it('stops a statement the client cancels, at its own time limit, and goes on', async () => {
      const c = await sosie.client({ requestTimeout: 500, cancelTimeout: 5000 })
      const error = await failure('SELECT COUNT_BIG(*) AS n FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c', undefined, c)
      expect(error.message).toMatch(/^Timeout: Request failed to complete in 500ms/)
      expect(await rows('SELECT 1 AS one', undefined, c)).toEqual([{ one: 1 }])
    })
  })

  describe('TLS', () => {
    it('serves TDS 8 (Encrypt=strict) to a client that trusts Sosie’s CA', async () => {
      const strict = await sosie.client({ encrypt: 'strict', trustServerCertificate: false, cryptoCredentialsDetails: { ca: readFileSync(sosie.ca, 'utf8') } } as never)
      expect(await rows('SELECT COUNT(*) AS n FROM countries', undefined, strict)).toEqual([{ n: 3 }])
    })

    it('serves a client that asks for no TLS, in clear', async () => {
      const clear = await sosie.client({ encrypt: false })
      expect(await rows('SELECT COUNT(*) AS n FROM countries', undefined, clear)).toEqual([{ n: 3 }])
    })

    it('is refused by a client that checks the certificate and trusts no CA of Sosie’s', async () => {
      await expect(sosie.client({ trustServerCertificate: false })).rejects.toThrow(/certificate/)
    })
  })
})
