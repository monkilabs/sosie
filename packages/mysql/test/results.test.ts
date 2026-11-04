import type { RequestScope } from '@sosie/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { scrubbed, type Sent } from '../src/errors.js'
import { analyze, loadParser, parseStatements, type Analysis } from '../src/guard.js'
import type { Column } from '../src/protocol.js'
import { planColumns } from '../src/results.js'
import { rewriteConsts } from '../src/rewrite.js'
import { buildCatalog } from '../src/schema.js'

beforeAll(() => loadParser())

const catalog = buildCatalog({
  database: 'app',
  tables: [{ db: 'app', name: 'users', kind: 'BASE TABLE' }],
  columns: [
    { db: 'app', table: 'users', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
    { db: 'app', table: 'users', name: 'email', dataType: 'varchar', columnType: 'varchar(120)', maxLength: 120 },
    { db: 'app', table: 'users', name: 'city', dataType: 'varchar', columnType: 'varchar(60)', maxLength: 60 },
  ],
  primary: [{ db: 'app', table: 'users', column: 'id' }],
  unique: [],
  references: [],
  functions: [],
  grants: [],
})

const check = (sql: string) => analyze(parseStatements(sql)[0]!, sql, catalog, 'app', { statementTimeout: 30_000, maxRows: 1000 })

/** A result column as MySQL describes one: computed (no table) unless told otherwise. */
const column = (over: Partial<Column> = {}): Column => ({
  schema: '', table: '', orgTable: '', name: 'c', orgName: '', characterSet: 255, length: 0, type: 253, flags: 0, decimals: 0, ...over,
})
const of = (table: string, name: string, schema = 'app') => column({ schema, table, orgTable: table, name, orgName: name })
const plans = (sql: string, columns: Column[]) => planColumns(columns, check(sql), catalog).map((p) => ('pass' in p ? 'pass' : 'field' in p ? p.field.id : p.type.kind))

describe('what each result column becomes', () => {
  it('a column MySQL names a table for: a fake by its field', () => {
    expect(plans('SELECT email FROM users', [of('users', 'email')])).toEqual(['users.email'])
  })

  it('a computed column: a fake by its type where the statement reads data, as it is where it reads none', () => {
    expect(plans('SELECT UPPER(email) FROM users', [column()])).toEqual(['string'])
    expect(plans('SELECT NOW(), VERSION()', [column(), column()])).toEqual(['pass', 'pass'])
    expect(plans("SELECT COUNT(*), 'x' FROM users", [column({ type: 8 }), column()])).toEqual(['pass', 'pass'])
  })

  it('a column from a table of yours makes the statement one that reads data, whatever the guard made of it', () => {
    const misread: Analysis = { catalogOnly: true, answer: 'rows', consts: [], params: new Map() }
    const plan = planColumns([of('users', 'email'), column()], misread, catalog)
    expect(plan[1]).toEqual({ type: { kind: 'string' } })
  })

  it('a UNION column passes only where every branch has a count or a literal in its place', () => {
    const total = "SELECT 'All' AS city, COUNT(*) AS n FROM users UNION ALL SELECT city, COUNT(*) FROM users GROUP BY city"
    expect(plans(total, [column(), column({ type: 8 })])).toEqual(['string', 'pass'])
    expect(plans("SELECT 'x' AS e UNION SELECT email FROM users", [column()])).toEqual(['string'])
    expect(plans('SELECT COUNT(*) FROM users UNION ALL SELECT id FROM users', [column({ type: 8 })])).toEqual(['integer'])
  })

  it('a function the guard does not know: read as reading data, so what it gives is faked', () => {
    expect(plans('SELECT email_for(1)', [column()])).toEqual(['string'])
  })

  it('SHOW, DESCRIBE and MySQL’s catalog: unchanged', () => {
    expect(plans('SHOW TABLES', [column()])).toEqual(['pass'])
    expect(plans('SELECT TABLE_NAME FROM information_schema.TABLES', [of('TABLES', 'TABLE_NAME', 'information_schema')])).toEqual(['pass'])
  })
})

describe('errors', () => {
  const real = 'quill.vantablack@canary-mail.test'
  const fake = 'van29@example.com'
  const scope = {
    lookup: (v: string) => (v === fake ? real : undefined),
    turnedBack: () => false,
    scrub: (t: string) => t.split(real).join(fake),
  } as unknown as RequestScope
  const sent = (text: string): Sent => {
    const rewritten = rewriteConsts(text, check(text).consts, scope)
    return { text, sql: rewritten?.sql ?? text, edits: rewritten?.edits ?? [], scope }
  }
  const syntax = (sql: string, at: number) =>
    `You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '${sql.slice(at, at + 80)}' at line 1`

  it('quote the statement from the client’s own text: MySQL’s quote of what Sosie sent may cut a real value short', () => {
    const text = `SELECT id FROM users WHERE id ILIKE '${'x'.repeat(40)}' OR email = '${fake}'`
    const s = sent(text)
    expect(s.sql).toContain(real)
    const message = scrubbed(1064, syntax(s.sql, s.sql.indexOf('ILIKE')), s, catalog)
    expect(message).not.toMatch(/quill|canary/)
    expect(message).toContain(`near '${text.slice(text.indexOf('ILIKE'), text.indexOf('ILIKE') + 80)}' at line 1`)
  })

  it('quote from the client’s text where the quote starts inside a value Sosie put there', () => {
    const text = `SELECT id FROM users WHERE email = '${fake}' ILIKE 1`
    const s = sent(text)
    const message = scrubbed(1064, syntax(s.sql, s.sql.indexOf('canary')), s, catalog)
    expect(message).not.toMatch(/quill|canary/)
    expect(message).toContain(`near '${text.slice(text.indexOf(`'${fake}`))}' at line 1`)
  })

  it('hide what is quoted that the client did not write and that names nothing in the schema', () => {
    const s = sent('SELECT nope FROM users u WHERE u.emial = 1')
    expect(scrubbed(1054, "Unknown column 'u.emial' in 'where clause'", s, catalog)).toBe("Unknown column 'u.emial' in 'where clause'")
    expect(scrubbed(1146, "Table 'app.userz' doesn't exist", sent('SELECT * FROM userz'), catalog)).toBe("Table 'app.userz' doesn't exist")
    expect(scrubbed(1235, "This version of MySQL doesn't yet support 'Vantaville'", s, catalog)).toBe("This version of MySQL doesn't yet support '…'")
    expect(scrubbed(1235, "This version of MySQL doesn't yet support 'O'Brien'", s, catalog)).toBe("This version of MySQL doesn't yet support '…'")
    expect(scrubbed(1044, "Access denied for user 'sosie_reader'@'%' to database 'mysql'", sent('USE mysql'), catalog)).toBe(
      "Access denied for user '…'@'…' to database 'mysql'",
    )
  })

  it('show any other error by its code only', () => {
    expect(scrubbed(1366, "Incorrect integer value: 'Vantaville' for column 'id' at row 1", sent('SELECT 1'), catalog)).toMatch(/^Error 1366: Sosie hides/)
  })
})
