import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir } from '@sosie/core'
import { postgres } from '@sosie/postgres'
import pg from 'pg'
import { inject } from 'vitest'

export interface Started {
  address: string
  warnings: string[]
  home: string
  store: Store
  client(): Promise<pg.Client>
  close(): Promise<void>
}

/** Start Sosie in front of the test database, as the CLI does. */
export async function startSosie({
  rules = '',
  maxRows = 100,
  home = mkdtempSync(join(tmpdir(), 'sosie-e2e-')),
  upstream = new URL(inject('upstream')),
} = {}): Promise<Started> {
  const connection = await postgres.connect(upstream, { maxRows, statementTimeout: 5000 })
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules: loadRules(rules, connection.schema), store })
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker)
  const clients: pg.Client[] = []
  return {
    address: endpoint.address,
    warnings: connection.warnings,
    home,
    store,
    async client() {
      const client = new pg.Client({ connectionString: endpoint.address })
      client.on('error', () => {})
      await client.connect()
      clients.push(client)
      return client
    },
    async close() {
      await Promise.all(clients.map((c) => c.end().catch(() => {})))
      await endpoint.close()
      await connection.close()
      store.close()
    },
  }
}

/** A client straight to the real database, for comparing. */
export async function real(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: inject('admin') })
  await client.connect()
  return client
}
