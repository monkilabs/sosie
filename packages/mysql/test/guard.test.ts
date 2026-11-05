import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, literalText, loadParser, parseStatements } from '../src/guard.js'
import { buildCatalog } from '../src/schema.js'

beforeAll(() => loadParser())

/** A small catalog, as readCatalog would build it from information_schema's rows. */
const catalog = buildCatalog({
  database: 'app',
  tables: [
    { db: 'app', name: 'users', kind: 'BASE TABLE' },
    { db: 'app', name: 'orders', kind: 'BASE TABLE' },
    { db: 'billing', name: 'invoices', kind: 'BASE TABLE' },
  ],
  columns: [
    { db: 'app', table: 'users', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
    { db: 'app', table: 'users', name: 'email', dataType: 'varchar', columnType: 'varchar(120)', maxLength: 120 },
    { db: 'app', table: 'users', name: 'role', dataType: 'enum', columnType: "enum('admin','viewer')", maxLength: null },
    { db: 'app', table: 'orders', name: 'id', dataType: 'bigint', columnType: 'bigint', maxLength: null },
    { db: 'app', table: 'orders', name: 'user_id', dataType: 'int', columnType: 'int', maxLength: null },
    { db: 'billing', table: 'invoices', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
  ],
  primary: [{ db: 'app', table: 'users', column: 'id' }],
  unique: [{ db: 'app', table: 'users', column: 'email' }],
  references: [{ db: 'app', table: 'orders', column: 'user_id', refDb: 'app', refTable: 'users', refColumn: 'id' }],
  functions: ['email_of'],
  grants: ['GRANT SELECT ON `app`.* TO `reader`@`%`'],
})

const check = (sql: string) => analyze(parseStatements(sql)[0]!, sql, catalog, 'app', { statementTimeout: 30_000, maxRows: 1000 })
const near = (sql: string) => check(sql).consts.map((c) => [c.value, c.near === 'catalog' ? 'catalog' : c.near?.id])

describe('the guard', () => {
  it.each([
    'SELECT * FROM users',
    'SELECT u.email, o.id FROM users u JOIN orders o ON o.user_id = u.id',
    'WITH x AS (SELECT id FROM users) SELECT * FROM x',
    'SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)',
    'SELECT COUNT(*) FROM users',
    'SELECT * FROM information_schema.COLUMNS',
    'SELECT @@version, @@session.sql_mode, @@max_allowed_packet',
    'SHOW TABLES',
    'SHOW FULL COLUMNS FROM users',
    'SHOW CREATE TABLE users',
    'SHOW INDEX FROM users',
    'SHOW GRANTS',
    'SHOW WARNINGS',
    'DESCRIBE users',
    'USE billing',
    'BEGIN',
    'START TRANSACTION READ ONLY',
    'COMMIT',
    'SET NAMES utf8mb4',
    'SET autocommit = 0, time_zone = \'+00:00\'',
    "SET SESSION sql_mode = 'STRICT_TRANS_TABLES'",
    "SET sql_mode = 'TRADITIONAL,ONLY_FULL_GROUP_BY'",
    "SET sql_mode = ''",
    'SET max_execution_time = 1000',
    'SET @x = 1',
    'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
    'SET SESSION TRANSACTION READ ONLY',
    'SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM users',
    'SELECT /*+ SET_VAR(sort_buffer_size = 262144) */ * FROM users',
    'SELECT * FROM users u JOIN LATERAL (SELECT * FROM orders o WHERE o.user_id = u.id LIMIT 1) AS l ON TRUE',
  ])('runs %s', (sql) => {
    expect(check(sql).refusal).toBeUndefined()
  })

  it.each([
    ['INSERT INTO users (id) VALUES (1)', 1792],
    ['UPDATE users SET email = NULL', 1792],
    ['DELETE FROM users', 1792],
    ['DROP TABLE users', 1792],
    ['CREATE TABLE t (id INT)', 1792],
    ['TRUNCATE TABLE users', 1792],
    ['CALL p()', 1792],
    ['KILL 1', 1792],
    ['START TRANSACTION READ WRITE', 1792],
    ['SET TRANSACTION READ WRITE', 1792],
    ["SELECT LOAD_FILE('/etc/passwd')", 1227],
    ["SELECT GET_LOCK('x', 1)", 1227],
    ['SELECT @@datadir', 1227],
    ['SELECT @@global.hostname', 1227],
    ['SELECT * FROM mysql.user', 1227],
    ['SELECT * FROM performance_schema.events_statements_history', 1227],
    ['SELECT * FROM sys.statement_analysis', 1227],
    ['SELECT * FROM information_schema.PROCESSLIST', 1227],
    ['SELECT * FROM information_schema.COLUMN_STATISTICS', 1227],
    ['SHOW PROCESSLIST', 1227],
    ['SHOW VARIABLES', 1227],
    ['SHOW ENGINE INNODB STATUS', 1227],
    ['SHOW BINARY LOGS', 1227],
    ['SELECT * FROM users FOR UPDATE', 1227],
    ['SELECT id INTO @x FROM users', 1227],
    ['EXPLAIN SELECT * FROM users', 1235],
    ['SET GLOBAL max_connections = 1', 1227],
    ['SET @@global.sql_mode = \'\'', 1227],
    ['SET SESSION transaction_read_only = OFF', 1227],
    ["SET sql_mode = 'ANSI_QUOTES'", 1227],
    ['SET sql_mode = DEFAULT', 1227],
    // A number sets modes by their bits: 1048576 is NO_BACKSLASH_ESCAPES, 4 ANSI_QUOTES.
    ['SET sql_mode = 1048576', 1227],
    ['SHOW STATUS', 1227],
    ["SHOW GLOBAL STATUS LIKE 'Mysqlx_socket'", 1227],
    ['SET SESSION sql_mode = 4', 1227],
    ["SET sql_mode = 'IGNORE_SPACE'", 1227],
    ["SET sql_mode = 'STRICT_TRANS_TABLES,HIGH_NOT_PRECEDENCE'", 1227],
    ["SET sql_mode = 'NO_SUCH_MODE'", 1227],
    ['SELECT /*+ SET_VAR(sql_mode = 1048576) */ 1', 1227],
    ['SET max_execution_time = 0', 1227],
    ['SET max_execution_time = 999999', 1227],
    ['SET NAMES latin1', 1235],
    // A setting's value copied from a row would come back real from SELECT @@name.
    ['SET group_concat_max_len = (SELECT id FROM users LIMIT 1)', 1235],
    // MySQL runs what is in an executable comment: so does the guard read it.
    ["SELECT /*!50000 LOAD_FILE('/etc/passwd'), */ 1", 1227],
    // sqlparser reads these as SET TRANSACTION, for this session only: the text says otherwise.
    ['SET GLOBAL TRANSACTION READ ONLY', 1227],
    ['SET GLOBAL TRANSACTION ISOLATION LEVEL SERIALIZABLE', 1227],
    ['SET /*!80000 GLOBAL */ TRANSACTION READ ONLY', 1227],
    // An optimizer hint lifts a limit for one statement as SET would for the session.
    ['SELECT /*+ MAX_EXECUTION_TIME(100000) */ SLEEP(3)', 1227],
    ['SELECT /*+ MAX_EXECUTION_TIME(0) */ 1', 1227],
    ['SELECT /*+ SET_VAR(max_execution_time=100000) */ 1', 1227],
    ['SELECT /*+ SET_VAR(sql_select_limit = 100000) */ * FROM users', 1227],
    ["SELECT /*+ SET_VAR(sql_mode = 'ANSI_QUOTES') */ 1", 1227],
    ['SELECT id FROM users WHERE id IN (SELECT /*+ MAX_EXECUTION_TIME(100000) */ user_id FROM orders)', 1227],
  ])('refuses %s', (sql, code) => {
    expect(check(sql).refusal?.code).toBe(code)
  })

  it('finds what each literal is compared with', () => {
    expect(near("SELECT * FROM users WHERE email = 'kim@example.com'")).toEqual([['kim@example.com', 'users.email']])
    expect(near("SELECT * FROM users u WHERE u.id IN (7, 8) AND 'x' = u.email")).toEqual([
      ['7', 'users.id'],
      ['8', 'users.id'],
      ['x', 'users.email'],
    ])
    expect(near('SELECT * FROM orders o WHERE o.user_id = 7')).toEqual([['7', 'orders.user_id']])
    expect(near("SELECT * FROM billing.invoices WHERE id = 3")).toEqual([['3', 'billing.invoices.id']])
    // Through an introducer, a COLLATE and parentheses.
    expect(near("SELECT * FROM users WHERE email = (_utf8mb4'k@x.io' COLLATE utf8mb4_bin)")).toEqual([['k@x.io', 'users.email']])
    // A column of MySQL's own catalog: its literal is no fake.
    expect(near("SELECT * FROM information_schema.TABLES WHERE TABLE_NAME = 'users'")).toEqual([['users', 'catalog']])
    // Two tables with the column, unqualified: Sosie cannot tell which.
    expect(near('SELECT * FROM users, orders WHERE id = 7')).toEqual([['7', undefined]])
  })

  it('leaves alone a literal whose text it would not write back as it read it', () => {
    // 'a' 'b' is one literal to MySQL, 'ab', over two pieces of text.
    expect(near("SELECT * FROM users WHERE email = 'kim@' 'example.com'")).toEqual([])
    expect(literalText("'it\\'s'")).toBe("it's")
    expect(literalText("'it''s'")).toBe("it's")
    expect(literalText("'a' 'b'")).toBeUndefined()
  })

  it('tells what reads data, and what only the catalog', () => {
    expect(check('SELECT 1, NOW()').catalogOnly).toBe(true)
    expect(check('SELECT * FROM information_schema.TABLES').catalogOnly).toBe(true)
    expect(check('SELECT * FROM users').catalogOnly).toBe(false)
    expect(check('SELECT @x').catalogOnly).toBe(false)
    expect(check('SELECT email_of(1)').catalogOnly).toBe(false)
    // A function that is not MySQL's own may be one made since Sosie started, whose code reads rows.
    expect(check('SELECT made_since(1)').catalogOnly).toBe(false)
    expect(check('SELECT UPPER(CONCAT(DATABASE(), VERSION())), COALESCE(NULL, 1)').catalogOnly).toBe(true)
    // A table Sosie does not know, made since it started, is data too.
    expect(check('SELECT * FROM newer').catalogOnly).toBe(false)
    expect(check('SELECT (SELECT email FROM users LIMIT 1)').catalogOnly).toBe(false)
    expect(check('SHOW TABLES').answer).toBe('schema')
    expect(check('SHOW WARNINGS').answer).toBe('warnings')
  })

  it('reads a UNION column as a count or a literal only where every branch has one', () => {
    const targets = (sql: string) => check(sql).targets
    expect(targets("SELECT 'All' AS city, COUNT(*) AS n FROM users UNION ALL SELECT email, COUNT(*) FROM users GROUP BY email")).toEqual(['other', 'count'])
    expect(targets("SELECT 'x' AS e UNION SELECT email FROM users")).toEqual(['other'])
    expect(targets('SELECT COUNT(*) FROM users UNION ALL SELECT id FROM users')).toEqual(['other'])
    expect(targets("SELECT 'a', 1 UNION SELECT 'b', 2 UNION SELECT 'c', 3")).toEqual(['constant', 'constant'])
    expect(targets('SELECT * FROM users UNION SELECT * FROM users')).toEqual(['star'])
  })

  it('numbers parameters by where they are in the text', () => {
    const analysis = check('SELECT * FROM users WHERE email = ? AND id = ?')
    expect([...analysis.params].map(([n, f]) => [n, f === 'catalog' ? f : f?.id])).toEqual([
      [1, 'users.email'],
      [2, 'users.id'],
    ])
  })
})
