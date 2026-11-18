import type { Connection, Source } from '@sosie/core'
import { loadModule } from 'pgsql-parser'
import { startEndpoint } from './endpoint.js'
import { queryTool } from './mcp.js'
import { readCatalog } from './schema.js'
import { Upstream } from './upstream.js'

/** The Postgres source: a local Postgres endpoint in front of a real database, read-only, every value faked. */
export const postgres: Source = {
  kind: 'postgres',
  title: 'Postgres database',
  schemes: ['postgres:', 'postgresql:'],
  matches: (url) => url.protocol === 'postgres:' || url.protocol === 'postgresql:',
  async connect(upstream, options): Promise<Connection> {
    await loadModule()
    const host = upstream.searchParams.get('host') ?? (decodeURIComponent(upstream.hostname) || 'localhost')
    const port = upstream.searchParams.get('port') ?? (upstream.port || '5432')
    const database = decodeURIComponent(upstream.pathname.slice(1)) || decodeURIComponent(upstream.username) || 'postgres'
    const label = `${host}:${port}/${database}`
    let catalog
    try {
      catalog = await Upstream.query(upstream, options, readCatalog)
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
          ? ['The login is a superuser or can replicate. Sosie refuses the admin functions it knows, but a read-only login is safer.']
          : []),
        ...(catalog.writable
          ? [`The login can write to ${catalog.writable} ${catalog.writable === 1 ? 'table' : 'tables'}. Sosie's session is read-only, but a read-only login is safer.`]
          : []),
        // Answers with no rows, or fewer, would look like the data: said once, here.
        ...(catalog.rowSecurity.hidden
          ? [
              `Row security hides every row of ${tables(catalog.rowSecurity.hidden)} from the login: ${catalog.rowSecurity.hidden === 1 ? 'it has' : 'they have'} no policy. Give the login BYPASSRLS, or a policy that lets it read.`,
            ]
          : []),
        ...(catalog.rowSecurity.limited
          ? [`Row security shows the login only the rows its policies allow in ${tables(catalog.rowSecurity.limited)}: Sosie's answers leave the rest out.`]
          : []),
      ],
      serve: (listen, faker) =>
        startEndpoint(listen, database, {
          upstream,
          catalog,
          faker,
          maxRows: options.maxRows,
          statementTimeout: options.statementTimeout,
          log: (line) => process.stderr.write(`  ! ${line}\n`),
        }),
      async close() {},
    }
  },
  tools: [queryTool],
}

function tables(n: number): string {
  return `${n} ${n === 1 ? 'table' : 'tables'}`
}

export { parseArray, serializeArray } from './arrays.js'
export { analyze, parseStatements } from './guard.js'
export { buildCatalog, typeByName, typeByOid, type Catalog } from './schema.js'
