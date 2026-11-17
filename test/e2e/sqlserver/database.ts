import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Connection, Request } from 'tedious'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** A read-only login to the seeded database, as a developer gives Sosie one; empty when there is no SQL Server. */
    sqlserverUpstream: string
    /** A login that can do anything on it: for checks Sosie must not affect. */
    sqlserverAdmin: string
  }
}

/** A connection with a login of a sqlserver:// URL, as tedious takes one. */
export function connect(url: URL, database = decodeURIComponent(url.pathname.slice(1))): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = new Connection({
      server: url.hostname,
      authentication: { type: 'default', options: { userName: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } },
      options: { port: Number(url.port || 1433), database: database || 'master', trustServerCertificate: true, connectTimeout: 30_000, rowCollectionOnRequestCompletion: true },
    })
    connection.on('connect', (error) => (error ? reject(error) : resolve(connection)))
    connection.on('error', () => {})
    connection.connect()
  })
}

export function batch(connection: Connection, sql: string): Promise<void> {
  return new Promise((resolve, reject) => connection.execSqlBatch(new Request(sql, (error) => (error ? reject(error) : resolve()))))
}

/**
 * SQL Server for the end-to-end tests: SOSIE_TEST_SQLSERVER_URL, a login that may make a database and a login, such
 * as sa (CI runs SQL Server's container that way). SQL Server runs in no process of a test's own: without it, these
 * tests are skipped.
 */
export default async function setup(project: TestProject) {
  const server = process.env.SOSIE_TEST_SQLSERVER_URL
  if (!server) {
    project.provide('sqlserverUpstream', '')
    project.provide('sqlserverAdmin', '')
    return
  }
  const url = new URL(server)
  const suffix = `${process.pid}_${Date.now() % 100000}`
  const database = `sosie_test_${suffix}`
  const reader = `sosie_reader_${suffix}`
  const password = `Rd-${randomBytes(12).toString('hex')}`
  // SQL Server takes a moment after its container starts.
  let admin: Connection | undefined
  for (let tries = 0; !admin; tries++) {
    try {
      admin = await connect(url, 'master')
    } catch (error) {
      if (tries > 30) throw error
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  await batch(admin, `CREATE DATABASE ${database}`)
  await batch(admin, `USE ${database}`)
  for (const piece of readFileSync(new URL('./seed.sql', import.meta.url), 'utf8').split(/^\s*GO\s*$/m)) if (piece.trim()) await batch(admin, piece)
  await batch(admin, `CREATE LOGIN ${reader} WITH PASSWORD = '${password}', CHECK_POLICY = OFF, DEFAULT_DATABASE = ${database}`)
  await batch(admin, `CREATE USER ${reader} FOR LOGIN ${reader}; ALTER ROLE db_datareader ADD MEMBER ${reader}`)

  const at = (user: string, secret: string) => {
    const u = new URL(server)
    u.username = encodeURIComponent(user)
    u.password = encodeURIComponent(secret)
    u.pathname = `/${database}`
    if (!u.searchParams.has('trustServerCertificate')) u.searchParams.set('trustServerCertificate', 'true')
    return u.href
  }
  project.provide('sqlserverUpstream', at(reader, password))
  project.provide('sqlserverAdmin', at(decodeURIComponent(url.username), decodeURIComponent(url.password)))

  return async () => {
    await batch(admin, `USE master; ALTER DATABASE ${database} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${database}; DROP LOGIN ${reader}`)
    admin.close()
  }
}
