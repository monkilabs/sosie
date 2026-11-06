import type { Connection, Schema, Source } from '@sosie/core'
import type { Document } from 'bson'
import { startEndpoint } from './endpoint.js'
import { aggregateTool, findTool } from './mcp.js'
import { Catalog, readCollections } from './schema.js'
import { connect, Upstream } from './upstream.js'

/** MongoDB 6.0, wire version 17: the oldest Sosie reads. Older versions are past their end of life. */
const MIN_WIRE_VERSION = 17

/** Actions a login has that change data, or the server. */
const WRITE_ACTIONS = new Set(['insert', 'update', 'remove', 'createCollection', 'dropCollection', 'createIndex', 'dropIndex', 'dropDatabase', 'renameCollectionSameDB', 'convertToCapped', 'collMod', 'bypassDocumentValidation'])
const ADMIN_ACTIONS = new Set(['anyAction', 'createUser', 'grantRole', 'shutdown', 'setParameter', 'applyOps'])

/** The MongoDB source: a local MongoDB endpoint in front of a real database, read-only, every value faked. */
export const mongodb: Source = {
  kind: 'mongodb',
  title: 'MongoDB database',
  schemes: ['mongodb:', 'mongodb+srv:'],
  matches: (url) => url.protocol === 'mongodb:' || url.protocol === 'mongodb+srv:',
  tools: [findTool, aggregateTool],
  async connect(upstream, options): Promise<Connection> {
    const database = decodeURIComponent(upstream.pathname.slice(1))
    const label = `${decodeURIComponent(upstream.host)}/${database}`
    if (!database) throw new Error('Name the database in the connection string: mongodb://user:password@host:27017/database.')
    const client = connect(upstream)
    let catalog: Catalog
    let server: { version: string; minWireVersion: number; maxWireVersion: number }
    const warnings: string[] = []
    try {
      await client.connect()
      const db = client.db(database)
      const hello = await db.command({ hello: 1 })
      const build = await db.command({ buildInfo: 1 })
      server = { version: String(build.version), minWireVersion: Number(hello.minWireVersion ?? 0), maxWireVersion: Number(hello.maxWireVersion ?? 0) }
      if (server.maxWireVersion < MIN_WIRE_VERSION) throw new Error(`it is MongoDB ${server.version}; Sosie reads MongoDB 6.0 and later`)
      catalog = new Catalog(database)
      readCollections(catalog, await db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray())
      const status = await db.command({ connectionStatus: 1, showPrivileges: true }).catch(() => undefined)
      const actions = new Set<string>(((status?.authInfo as Document | undefined)?.authenticatedUserPrivileges ?? []).flatMap((p: Document) => p.actions ?? []))
      if ([...actions].some((a) => ADMIN_ACTIONS.has(a))) {
        warnings.push('The login is an administrator. Sosie refuses what it knows of that, but a login with the read role is safer.')
      } else if ([...actions].some((a) => WRITE_ACTIONS.has(a))) {
        warnings.push("The login can change data. Sosie runs no command that writes, but a login with the read role is safer.")
      }
    } catch (error) {
      await client.close().catch(() => {})
      throw new Error(`Cannot connect to ${label}: ${(error as Error).message}`)
    }
    const counts = [`${catalog.collections} ${catalog.collections === 1 ? 'collection' : 'collections'}`]
    if (catalog.views) counts.push(`${catalog.views} ${catalog.views === 1 ? 'view' : 'views'}`)
    const up = new Upstream(client)
    return {
      schema: catalog.schema,
      label,
      summary: counts.join(', '),
      client: 'mongosh',
      learns: true,
      warnings,
      serve: (listen, faker, learned) => {
        // Told as fields are met, at most every half second: describe lists what the documents have shown.
        let timer: NodeJS.Timeout | undefined
        const grew = () => {
          timer ??= setTimeout(() => {
            timer = undefined
            learned?.(catalog.schema as Schema)
          }, 500)
          timer.unref()
        }
        return startEndpoint(listen, database, {
          upstream: up,
          catalog,
          faker,
          maxRows: options.maxRows,
          statementTimeout: options.statementTimeout,
          server,
          learned: grew,
          log: (line) => process.stderr.write(`  ! ${line}\n`),
        })
      },
      async close() {
        await up.killOwned().catch(() => {})
        await client.close().catch(() => {})
      },
    }
  },
}
