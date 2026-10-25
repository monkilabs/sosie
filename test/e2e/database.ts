import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** A read-only login to the seeded database: what a developer gives Sosie. */
    upstream: string
    /** A superuser on the same database: for checks Sosie must not affect, and a login that can write. */
    admin: string
  }
}

/**
 * Postgres for the end-to-end tests: SOSIE_TEST_DATABASE_URL when set (CI runs
 * PostgreSQL 15 to 18 that way), or an embedded server started here.
 */
export default async function setup(project: TestProject) {
  let server = process.env.SOSIE_TEST_DATABASE_URL
  let embedded: EmbeddedPostgres | undefined
  if (!server) {
    const port = await freePort()
    embedded = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), 'sosie-pg-')),
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      onLog: () => {},
      onError: () => {},
    })
    await embedded.initialise()
    await embedded.start()
    server = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`
  }

  const suffix = `${process.pid}_${Date.now() % 100000}`
  const database = `sosie_test_${suffix}`
  const reader = `sosie_reader_${suffix}`
  const root = new pg.Client({ connectionString: server })
  await root.connect()
  await root.query(`CREATE DATABASE ${database}`)
  await root.query(`CREATE ROLE ${reader} LOGIN PASSWORD 'reader'`)

  const admin = new URL(server)
  admin.pathname = `/${database}`
  const seed = new pg.Client({ connectionString: admin.href })
  await seed.connect()
  await seed.query(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8'))
  await seed.query(`
    GRANT USAGE ON SCHEMA public, billing TO ${reader};
    GRANT SELECT ON ALL TABLES IN SCHEMA public, billing TO ${reader};
  `)
  await seed.end()

  const upstream = new URL(admin.href)
  upstream.username = reader
  upstream.password = 'reader'
  project.provide('upstream', upstream.href)
  project.provide('admin', admin.href)

  return async () => {
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await root.query(`DROP ROLE IF EXISTS ${reader}`)
    await root.end()
    await embedded?.stop()
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}
