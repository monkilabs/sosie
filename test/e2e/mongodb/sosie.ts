import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir, type Schema } from '@sosie/core'
import { mongodb } from '@sosie/mongodb'
import { MongoClient, type MongoClientOptions } from 'mongodb'
import { inject } from 'vitest'

/** Sosie's MongoDB source in front of the seeded database, and clients of it as an app would make them. */
export async function startSosie({ rules = '', maxRows = 100, statementTimeout = 5000, upstream = inject('mongodbUpstream') } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sosie-mongodb-'))
  const connection = await mongodb.connect(new URL(upstream), { maxRows, statementTimeout })
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules: loadRules(rules, connection.schema, 'sosie.yml', { learns: !!connection.learns }), store })
  const learned: Schema[] = []
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker, (schema) => learned.push(schema))
  const clients: MongoClient[] = []
  const database = decodeURIComponent(new URL(endpoint.address).pathname.slice(1))
  return {
    address: endpoint.address,
    database,
    warnings: connection.warnings,
    schema: connection.schema,
    learned,
    home,
    /** A client of Sosie: no login, as Sosie takes none. */
    async client(options: MongoClientOptions = {}) {
      const client = new MongoClient(endpoint.address, { serverSelectionTimeoutMS: 5000, ...options })
      await client.connect()
      clients.push(client)
      return client
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
      await endpoint.close()
      await connection.close()
      store.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}
