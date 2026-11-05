import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir } from '@sosie/core'
import { mysql } from '@sosie/mysql'
import mysql2 from 'mysql2/promise'
import { inject } from 'vitest'

/** Sosie's MySQL source in front of the seeded database, and connections to it as an app would make them. */
export async function startSosie({ rules = '', maxRows = 100, statementTimeout = 5000, upstream = inject('mysqlUpstream') } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sosie-mysql-'))
  const connection = await mysql.connect(new URL(upstream), { maxRows, statementTimeout })
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules: loadRules(rules, connection.schema), store })
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker)
  const clients: mysql2.Connection[] = []
  const address = new URL(endpoint.address)
  return {
    address: endpoint.address,
    port: Number(address.port),
    database: decodeURIComponent(address.pathname.slice(1)),
    warnings: connection.warnings,
    home,
    store,
    /** A connection through Sosie, as any user: Sosie checks no password. */
    async client(options: mysql2.ConnectionOptions = {}) {
      const client = await mysql2.createConnection({ host: '127.0.0.1', port: Number(address.port), user: 'kim', database: decodeURIComponent(address.pathname.slice(1)), ...options })
      client.on('error', () => {})
      clients.push(client)
      return client
    },
    async close() {
      await Promise.all(clients.map((c) => c.end().catch(() => {})))
      await endpoint.close()
      await connection.close()
      store.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}
