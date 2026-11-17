import type { Connection, Source } from '@sosie/core'
import { startEndpoint } from './endpoint.js'
import { loadParser } from './guard.js'
import { queryTool } from './mcp.js'
import { readCatalog, type Catalog } from './schema.js'
import { targetOf, Upstream } from './upstream.js'

/** The SQL Server source: a local SQL Server endpoint in front of a real database, read-only, every value faked. */
export const sqlserver: Source = {
  kind: 'sqlserver',
  title: 'SQL Server database',
  schemes: ['sqlserver:', 'mssql:'],
  matches: (url) => url.protocol === 'sqlserver:' || url.protocol === 'mssql:',
  tools: [queryTool],
  async connect(upstream, options): Promise<Connection> {
    await loadParser()
    const target = targetOf(upstream)
    const label = `${target.host}:${target.port}/${target.database}`
    if (!target.database) throw new Error('Name the database in the connection string: sqlserver://user:password@host:1433/database.')
    let catalog: Catalog
    let version: string
    try {
      const session = await Upstream.open(target)
      try {
        version = session.session.version
        catalog = await readCatalog((sql) => session.rows(sql))
      } finally {
        session.close()
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
      warnings: [
        ...(catalog.admin
          ? ["The login is sysadmin, or the database's owner (db_owner). Sosie refuses every write it reads, but a read-only login (db_datareader) is safer."]
          : catalog.writable
            ? ['The login can change data. Sosie refuses every write it reads, but a read-only login (db_datareader) is safer.']
            : []),
        ...(catalog.hiddenViews
          ? [
              `The login cannot see which tables ${catalog.hiddenViews === 1 ? '1 view reads' : `${catalog.hiddenViews} views read`} (VIEW DEFINITION): describe shares their columns' fakes only where one table has a column of that name. Their rows are faked by the tables SQL Server names.`,
            ]
          : []),
      ],
      serve: (listen, faker) =>
        startEndpoint(listen, catalog.database || target.database, {
          target,
          catalog,
          faker,
          maxRows: options.maxRows,
          statementTimeout: options.statementTimeout,
          version,
          log: (line) => process.stderr.write(`  ! ${line}\n`),
        }),
      async close() {},
    }
  },
}

export { analyze, loadParser, parseBatch, literalText } from './guard.js'
export { buildCatalog, typeOf, type Catalog } from './schema.js'
export { endpointCertificate } from './certificate.js'
