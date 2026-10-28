import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir, type Connection } from '@sosie/core'
import { postgres } from '@sosie/postgres'
import { rest } from '@sosie/rest'
import { startApi } from './api.js'
import { describe, expect, inject, it } from 'vitest'

/** A port free on 127.0.0.1 that another program holds on ::1; undefined where this machine has no IPv6. */
async function heldOnIpv6(): Promise<{ port: number; close(): Promise<void> } | undefined> {
  const listen = (host: string, port: number) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(port, host, () => resolve(server))
    })
  const probe = await listen('127.0.0.1', 0)
  const port = (probe.address() as { port: number }).port
  await new Promise((resolve) => probe.close(resolve))
  const other = await listen('::1', port).catch(() => undefined)
  return other && { port, close: () => new Promise<void>((resolve) => other.close(() => resolve())) }
}

/** Sosie's endpoint on a port, as the CLI asks for one. */
async function serve(connection: Connection, port: number) {
  const store = Store.open(storeDir(mkdtempSync(join(tmpdir(), 'sosie-listen-'))))
  const faker = createFaker({ schema: connection.schema, rules: loadRules('', connection.schema), store })
  try {
    return await connection.serve({ host: '127.0.0.1', port }, faker)
  } finally {
    store.close()
  }
}

describe('a port that another program holds on ::1, where localhost goes first', () => {
  it('is busy for a Sosie, which never prints an address that reaches that program', async (ctx) => {
    const held = await heldOnIpv6()
    if (!held) return ctx.skip('this machine has no IPv6')
    const connection = await postgres.connect(new URL(inject('upstream')), { maxRows: 10, statementTimeout: 5000 })
    try {
      await expect(serve(connection, held.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
      // A port Sosie picks itself is picked again.
      const endpoint = await serve(connection, 0)
      expect(new URL(endpoint.address).port).not.toBe(String(held.port))
      await endpoint.close()
    } finally {
      await connection.close()
      await held.close()
    }
  })

  it('is busy for a REST Sosie too', async (ctx) => {
    const held = await heldOnIpv6()
    if (!held) return ctx.skip('this machine has no IPv6')
    const api = await startApi()
    const connection = await rest.connect(new URL(api.url), { maxRows: 10, statementTimeout: 5000, env: {} })
    try {
      await expect(serve(connection, held.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await held.close()
      await api.close()
    }
  })
})
