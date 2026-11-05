import type { Connection, Source } from '@sosie/core'
import mysql2 from 'mysql2/promise'
import { startEndpoint } from './endpoint.js'
import { loadParser } from './guard.js'
import { queryTool } from './mcp.js'
import { readCatalog, type Catalog } from './schema.js'
import { config } from './upstream.js'

/** The MySQL source: a local MySQL endpoint in front of a real database, read-only, every value faked. */
export const mysql: Source = {
  kind: 'mysql',
  matches: (url) => url.protocol === 'mysql:',
  tools: [queryTool],
  async connect(upstream, options): Promise<Connection> {
    await loadParser()
    const database = decodeURIComponent(upstream.pathname.slice(1))
    const host = decodeURIComponent(upstream.hostname) || 'localhost'
    const label = `${host}:${upstream.port || 3306}/${database}`
    if (!database) throw new Error('Name the database in the connection string: mysql://user:password@host:3306/database.')
    let catalog: Catalog
    let version: string
    try {
      const connection = await mysql2.createConnection({ ...config(upstream), multipleStatements: false })
      try {
        const [rows] = await connection.query('SELECT VERSION() AS version')
        version = String((rows as { version: string }[])[0]?.version ?? '')
        if (/mariadb/i.test(version)) throw new Error(`it is MariaDB ${version}; Sosie reads MySQL 8.0 and later for now`)
        if (Number(version.split('.')[0]) < 8) throw new Error(`it is MySQL ${version}; Sosie reads MySQL 8.0 and later`)
        await connection.query('SET SESSION transaction_read_only = ON')
        catalog = await readCatalog(async (sql) => (await connection.query(sql))[0] as never, database)
      } finally {
        await connection.end().catch(() => {})
      }
    } catch (error) {
      throw new Error(`Cannot connect to ${label}: ${(error as Error).message}`)
    }
    const counts = [`${catalog.tables} ${catalog.tables === 1 ? 'table' : 'tables'}`]
    if (catalog.views) counts.push(`${catalog.views} ${catalog.views === 1 ? 'view' : 'views'}`)
    return {
      schema: catalog.schema,
      label,
      summary: counts.join(', '),
      client: 'mysql',
      warnings: [
        ...(catalog.admin
          ? ['The login is an administrator, or may read files (FILE). Sosie refuses what it knows of that, but a read-only login is safer.']
          : []),
        ...(catalog.writable ? ["The login can change data. Sosie's session is read-only, but a read-only login is safer."] : []),
        ...(catalog.hiddenViews
          ? [
              `The login cannot see which tables ${catalog.hiddenViews === 1 ? '1 view reads' : `${catalog.hiddenViews} views read`} (SHOW VIEW): their columns share a table's fakes only where one table has a column of that name.`,
            ]
          : []),
      ],
      serve: (listen, faker) =>
        startEndpoint(listen, database, {
          upstream,
          catalog,
          faker,
          maxRows: options.maxRows,
          statementTimeout: options.statementTimeout,
          serverVersion: version,
          log: (line) => process.stderr.write(`  ! ${line}\n`),
        }),
      async close() {},
    }
  },
}

export { analyze, loadParser, parseStatements, literalText } from './guard.js'
export { buildCatalog, enumLabels, typeOf, typeOfColumn, type Catalog } from './schema.js'
