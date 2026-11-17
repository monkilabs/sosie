import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir } from '@sosie/core'
import { sqlserver } from '@sosie/sqlserver'
import { Connection, Request, type ConnectionConfiguration } from 'tedious'
import { inject } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any -- rows as tedious returns them. */
export type Row = Record<string, any>

/** What a request answered: its result sets, Sosie's notes and the server's messages, or the error. */
export interface Answer {
  sets: Row[][]
  infos: string[]
  error?: { number: number; message: string }
}

/** Sosie's SQL Server source in front of the seeded database, and connections to it as an app would make them. */
export async function startSosie({ rules = '', maxRows = 100, statementTimeout = 5000, upstream = inject('sqlserverUpstream') } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sosie-sqlserver-'))
  const previous = process.env.SOSIE_HOME
  process.env.SOSIE_HOME = home
  const connection = await sqlserver.connect(new URL(upstream), { maxRows, statementTimeout })
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules: loadRules(rules, connection.schema), store })
  const endpoint = (await connection.serve({ host: '127.0.0.1', port: 0 }, faker)) as Awaited<ReturnType<typeof connection.serve>> & { ca: string }
  const port = Number(/Server=[^,]+,(\d+)/.exec(endpoint.address)![1])
  const database = /Database=([^;]+)/.exec(endpoint.address)![1]!
  const clients: Connection[] = []
  return {
    address: endpoint.address,
    port,
    database,
    ca: endpoint.ca,
    warnings: connection.warnings,
    home,
    store,
    /** A connection through Sosie, as any user: Sosie checks no password. */
    async client(options: ConnectionConfiguration['options'] = {}): Promise<Connection> {
      const client = await new Promise<Connection>((resolve, reject) => {
        const c = new Connection({
          server: '127.0.0.1',
          authentication: { type: 'default', options: { userName: 'kim', password: 'anything' } },
          options: { port, database, trustServerCertificate: true, connectTimeout: 10_000, ...options },
        })
        c.on('connect', (error) => (error ? reject(error) : resolve(c)))
        c.on('error', () => {})
        c.connect()
      })
      clients.push(client)
      return client
    },
    async close() {
      for (const c of clients) c.close()
      await endpoint.close()
      await connection.close()
      store.close()
      if (previous === undefined) delete process.env.SOSIE_HOME
      else process.env.SOSIE_HOME = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Run a request on a connection: a batch, or with parameters as sp_executesql. */
export function ask(client: Connection, sql: string, params: [string, any, any, Record<string, unknown>?][] = []): Promise<Answer> {
  return new Promise((resolve) => {
    const answer: Answer = { sets: [], infos: [] }
    let rows: Row[] | undefined
    const onInfo = (info: { message: string }) => answer.infos.push(info.message)
    client.on('infoMessage', onInfo)
    const request = new Request(sql, (error) => {
      client.off('infoMessage', onInfo)
      if (error) {
        const e = error as Error & { number?: number; errors?: { number: number; message: string }[] }
        answer.error = { number: e.number ?? e.errors?.[0]?.number ?? 0, message: e.message }
      }
      resolve(answer)
    })
    request.on('columnMetadata', () => answer.sets.push((rows = [])))
    request.on('row', (columns: { value: unknown; metadata: { colName: string } }[]) =>
      rows?.push(Object.fromEntries(columns.map((c, i) => [c.metadata.colName || `column${i + 1}`, c.value]))),
    )
    for (const [name, type, value, options] of params) request.addParameter(name, type, value, options)
    if (params.length) client.execSql(request)
    else client.execSqlBatch(request)
  })
}
