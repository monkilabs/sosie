import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, literalText, loadParser, parseBatch } from '../src/guard.js'
import { buildCatalog } from '../src/schema.js'

beforeAll(() => loadParser())

/** A small catalog, as readCatalog would build it from sys.objects' and sys.columns' rows. */
export const catalog = buildCatalog({
  tables: [
    { schema: 'dbo', name: 'users', kind: 'U' },
    { schema: 'dbo', name: 'orders', kind: 'U' },
    { schema: 'billing', name: 'invoices', kind: 'U' },
    { schema: 'dbo', name: 'active_users', kind: 'V' },
  ],
  columns: [
    { schema: 'dbo', table: 'users', name: 'id', type: 'int', maxLength: 4 },
    { schema: 'dbo', table: 'users', name: 'email', type: 'nvarchar', maxLength: 240 },
    { schema: 'dbo', table: 'orders', name: 'id', type: 'bigint', maxLength: 8 },
    { schema: 'dbo', table: 'orders', name: 'user_id', type: 'int', maxLength: 4 },
    { schema: 'billing', table: 'invoices', name: 'number', type: 'varchar', maxLength: 20 },
    { schema: 'dbo', table: 'active_users', name: 'email', type: 'nvarchar', maxLength: 240 },
  ],
  primary: [{ schema: 'dbo', table: 'users', column: 'id' }],
  unique: [{ schema: 'dbo', table: 'users', column: 'email' }],
  references: [{ schema: 'dbo', table: 'orders', column: 'user_id', refSchema: 'dbo', refTable: 'users', refColumn: 'id' }],
  viewUses: [{ schema: 'dbo', view: 'active_users', tableSchema: 'dbo', table: 'users' }],
  functions: [{ schema: 'dbo', table: '', column: 'email_of' }],
  login: { defaultSchema: 'dbo', database: 'app', admin: false, writable: false, azure: false },
})

const check = (sql: string) => analyze(parseBatch(sql), sql, catalog, 'app', { maxRows: 1000 })
const near = (sql: string) => check(sql).consts.map((c) => [c.value, c.near === 'catalog' ? 'catalog' : c.near?.id])

describe('the guard', () => {
  it.each([
    'SELECT * FROM users',
    'SELECT TOP 10 [u].[email] FROM [dbo].[users] AS u WITH (NOLOCK)',
    'SELECT u.email, o.id FROM users u JOIN orders o ON o.user_id = u.id',
    'SELECT u.email, a.n FROM users u CROSS APPLY (SELECT COUNT(*) AS n FROM orders o WHERE o.user_id = u.id) a',
    'WITH x AS (SELECT id FROM users) SELECT * FROM x',
    'SELECT id, email FROM users FOR JSON PATH',
    'SELECT email FROM users ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY',
    'SELECT * FROM INFORMATION_SCHEMA.COLUMNS',
    'SELECT name FROM sys.tables',
    'SELECT @@VERSION, @@SPID, DB_NAME()',
    "SELECT SERVERPROPERTY('ProductVersion')",
    'USE app',
    'BEGIN TRAN',
    'COMMIT',
    'ROLLBACK TRANSACTION',
    'SET NOCOUNT ON',
    'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
    'SET ROWCOUNT 100',
    'SET STATISTICS IO ON',
    'DECLARE @x int = 1; SELECT @x',
    "EXEC sp_columns @table_name = N'users'",
    // JDBC's commit and rollback.
    'IF @@TRANCOUNT > 0 ROLLBACK TRAN',
    'IF @@TRANCOUNT > 0 COMMIT TRAN',
    'IF EXISTS (SELECT 1 FROM users) SELECT 1 ELSE SELECT 2',
    'set textsize 2147483647 set quoted_identifier on set arithabort off set language us_english set dateformat mdy',
  ])('allows %s', (sql) => {
    expect(check(sql).refusal).toBeUndefined()
  })

  it.each([
    ["UPDATE users SET email = 'x'", 3906],
    ['INSERT INTO users (email) VALUES (1)', 3906],
    ['DELETE FROM users', 3906],
    ['MERGE users AS t USING orders AS s ON t.id = s.user_id WHEN MATCHED THEN DELETE;', 3906],
    ['CREATE TABLE t (a int)', 3906],
    ['DROP TABLE users', 3906],
    ['TRUNCATE TABLE orders', 3906],
    ['SELECT email INTO #t FROM users', 229],
    ['SELECT email FROM users WITH (XLOCK)', 229],
    ['EXEC dbo.purge_everything', 50000],
    // BEGIN TRY, which sqlparser reads as BEGIN TRANSACTION.
    ['BEGIN TRY', 50000],
    ['END CATCH', 50000],
    // Its second result set holds the paths of the database's files.
    ["EXEC sp_helpdb N'app'", 50000],
    ["EXEC ('SELECT 1')", 50000],
    ['EXEC sp_executesql N\'SELECT 1\'', 50000],
    ['SELECT @@SERVERNAME', 229],
    ["SELECT SERVERPROPERTY('MachineName')", 229],
    ["SELECT CONNECTIONPROPERTY('local_net_address')", 229],
    ['SELECT * FROM sys.dm_exec_requests', 229],
    ['SELECT * FROM sys.dm_exec_sql_text(0x01)', 229],
    ['SELECT * FROM sys.sql_logins', 229],
    ['SELECT * FROM sysprocesses', 229],
    ['SELECT * FROM msdb.dbo.backupset', 229],
    ['USE msdb', 229],
    ["SELECT * FROM OPENROWSET('MSOLEDBSQL', 'Server=x', 'SELECT 1') AS t", 229],
    ["SELECT * FROM OPENQUERY(remote, 'SELECT 1')", 229],
    ['SELECT * FROM remote.app.dbo.users', 229],
    ['SELECT * FROM sys.fn_dblog(NULL, NULL)', 229],
    ['SELECT id FROM users FOR XML PATH', 50000],
    ['SET NO_BROWSETABLE OFF', 229],
    ['SET SHOWPLAN_XML ON', 229],
    ['SET STATISTICS XML ON', 229],
    ['SET ROWCOUNT 0', 229],
    ['SET ROWCOUNT 5000', 229],
    ['SET IDENTITY_INSERT users ON', 50000],
    ["PRINT 'hi'", 50000],
    ["IF 1 = 1 UPDATE users SET email = 'x'", 3906],
    // A write after a read, with no semicolon between: the batch is read on, and the write refused.
    ['SELECT 1 DELETE FROM users', 3906],
  ])('refuses %s', (sql, number) => {
    expect(check(sql).refusal?.number).toBe(number)
  })

  it('reads a batch with no semicolons as SQL Server does: one statement after another', () => {
    const text = 'SET NOCOUNT ON\nSELECT email FROM users WHERE id = 5 SELECT 1'
    const statements = parseBatch(text)
    expect(statements.map((s) => Object.keys(s.stmt)[0])).toEqual(['Set', 'Query', 'Query'])
    const [ref] = check(text).consts
    expect(text.slice(ref!.start, ref!.end)).toBe('5')
  })

  it('throws on what it cannot read, rather than guess: the session answers a syntax error', () => {
    expect(() => parseBatch('SELECT FROM WHERE')).toThrow()
    // T-SQL's DELETE without FROM, which sqlparser does not read: refused all the same.
    expect(() => parseBatch('DELETE users')).toThrow()
    expect(() => parseBatch('WHILE 1 = 1 SELECT 1')).toThrow()
  })

  it('throws where sqlparser stops at an END before the batch does, rather than let the rest go unread', () => {
    // sqlparser ends a list of statements at an END where one could end, without an error: SQL Server reads on.
    expect(() => parseBatch('BEGIN TRY SELECT 1 END TRY BEGIN CATCH DELETE FROM users END CATCH')).toThrow()
    expect(() => parseBatch('BEGIN TRY SELECT 1 END TRY BEGIN CATCH SELECT 1 END CATCH; SELECT UPPER(email) FROM users')).toThrow()
    expect(() => parseBatch('DECLARE @h uniqueidentifier; SELECT 1 END CONVERSATION @h; DELETE FROM users')).toThrow()
    // A mark of the client's cannot stand for Sosie's own.
    expect(() => parseBatch("SELECT 'sosie:end' END CONVERSATION @h; DELETE FROM users")).toThrow()
    // What sqlparser reads to its end is as before.
    expect(parseBatch('SELECT CASE WHEN id = 1 THEN 1 END FROM users; IF 1 = 1 BEGIN SELECT 1; END').map((s) => Object.keys(s.stmt)[0])).toEqual(['Query', 'If'])
  })

  it('keeps each literal compared with a column, where it is in the text, N and all', () => {
    const sql = "SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE u.email = N'kim@x.net' AND o.id IN (5, 6) AND u.id <> 7"
    expect(near(sql)).toEqual([
      ['kim@x.net', 'users.email'],
      ['5', 'orders.id'],
      ['6', 'orders.id'],
      ['7', 'users.id'],
    ])
    const [ref] = check(sql).consts
    expect(sql.slice(ref!.start, ref!.end)).toBe("N'kim@x.net'")
    expect(ref!.national).toBe(true)
  })

  it('finds a column through a schema, a view, a CTE, a derived table', () => {
    expect(near("SELECT 1 FROM billing.invoices WHERE number = 'INV-1'")).toEqual([['INV-1', 'billing.invoices.number']])
    expect(near("SELECT 1 FROM active_users WHERE email = 'a'")).toEqual([['a', 'active_users.email']])
    expect(near("WITH c AS (SELECT email AS mail FROM users) SELECT 1 FROM c WHERE mail = 'b'")).toEqual([['b', 'users.email']])
    expect(near("SELECT 1 FROM (SELECT email FROM users) x WHERE x.email = 'c'")).toEqual([['c', 'users.email']])
  })

  it('keeps each parameter compared with a column, by its name', () => {
    const analysis = check('SELECT * FROM users WHERE email = @P1 AND id = @id')
    expect([...analysis.params].map(([name, f]) => [name, f === 'catalog' ? f : f?.id])).toEqual([
      ['@p1', 'users.email'],
      ['@id', 'users.id'],
    ])
  })

  it('reads only the catalog when no table of yours is read: values pass', () => {
    expect(check('SELECT name FROM sys.tables').catalogOnly).toBe(true)
    expect(check('SELECT GETDATE(), 1 + 1').catalogOnly).toBe(true)
    expect(check('SELECT email FROM users').catalogOnly).toBe(false)
    // A function of yours may read rows; a variable may hold a value from one.
    expect(check('SELECT dbo.email_of(1)').catalogOnly).toBe(false)
    expect(check('DECLARE @x nvarchar(9); SELECT @x').catalogOnly).toBe(false)
  })

  it('reads as the catalog only sys and INFORMATION_SCHEMA, whichever database the session is in', () => {
    // A USE in a branch that never runs leaves the session where it was: users is still yours.
    expect(check('IF 1 = 0 USE master; SELECT UPPER(email) FROM users').catalogOnly).toBe(false)
    // So does a USE the login has no access to, which fails and lets the batch go on.
    expect(check('USE model; SELECT UPPER(email) FROM users').catalogOnly).toBe(false)
    // Tables in the system databases hold rows like any other: another session's global temp table among them.
    expect(check('SELECT * FROM tempdb..##staging').catalogOnly).toBe(false)
    expect(check('SELECT * FROM master.dbo.app_settings').catalogOnly).toBe(false)
    expect(check('SELECT name FROM master.sys.databases').catalogOnly).toBe(true)
    expect(check('USE master; SELECT name FROM sys.objects').catalogOnly).toBe(true)
  })

  it('says what each result set is: a count, a literal, FOR JSON; none for a SELECT that sets a variable', () => {
    const shapes = check("SELECT COUNT(*), 'x', email FROM users; SELECT @x = email FROM users; SELECT id FROM users FOR JSON PATH").shapes
    expect(shapes).toEqual([
      { targets: ['count', 'constant', 'other'], json: false },
      { targets: ['other'], json: true },
    ])
  })
})

describe('literalText', () => {
  it.each([
    ["'kim'", 'kim'],
    ["N'kim'", 'kim'],
    ["'O''Brien'", "O'Brien"],
    ['42', '42'],
    ['3.5', '3.5'],
    ["'a' + 'b'", undefined],
    ["'unclosed", undefined],
  ])('%s', (text, value) => {
    expect(literalText(text)).toBe(value)
  })
})

describe('the catalog, as drivers read it', () => {
  it('passes a catalog procedure run with parameters, as JDBC’s getTables sends one', () => {
    const analysis = check('EXEC sp_tables @P0, @P1, @P2, @P3')
    expect(analysis.refusal).toBeUndefined()
    expect(analysis.catalogOnly).toBe(true)
  })

  it('reads a table variable filled from a catalog procedure as the catalog, as JDBC’s getColumns sends one', () => {
    const sql =
      'DECLARE @r TABLE(TABLE_NAME SYSNAME, COLUMN_NAME SYSNAME, IS_IDENTITY SMALLINT);' +
      'INSERT INTO @r EXEC sp_columns_100 @P0, @P1, @P2, @P3, @P4, @P5;' +
      "SELECT TABLE_NAME, COLUMN_NAME, CASE IS_IDENTITY WHEN 1 THEN 'YES' ELSE 'NO' END AS AUTO FROM @r ORDER BY TABLE_NAME"
    const analysis = check(sql)
    expect(analysis.refusal).toBeUndefined()
    expect(analysis.catalogOnly).toBe(true)
  })

  it('fills a table variable from nothing but a catalog procedure', () => {
    expect(check('DECLARE @r TABLE(a int); INSERT INTO @r EXEC dbo.anything').refusal?.number).toBe(50000)
    expect(check('DECLARE @r TABLE(a int); INSERT INTO @r SELECT id FROM users').refusal?.number).toBe(3906)
  })
})
