import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** A read-only login to the seeded MySQL database: what a developer gives Sosie. */
    mysqlUpstream: string
    /** A login that can do anything on it: for checks Sosie must not affect, and a login that can write. */
    mysqlAdmin: string
  }
}

/**
 * MySQL for the end-to-end tests: SOSIE_TEST_MYSQL_URL when set (CI runs MySQL 8.4 and 9 that way), a root login
 * on a server; or one started here from MySQL's own binaries, cached after the first run.
 */
export default async function setup(project: TestProject) {
  let server = process.env.SOSIE_TEST_MYSQL_URL
  let stop: (() => Promise<void>) | undefined
  if (!server) {
    const { createDB } = await import('mysql-memory-server')
    const db = await createDB({ version: process.env.SOSIE_TEST_MYSQL_VERSION ?? '8.4.x', logLevel: 'ERROR' })
    server = `mysql://${db.username}@127.0.0.1:${db.port}/`
    stop = () => db.stop()
  }
  const suffix = `${process.pid}_${Date.now() % 100000}`
  const database = `sosie_test_${suffix}`
  const reader = `sosie_reader_${suffix}`
  const url = new URL(server)
  const root = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    multipleStatements: true,
  })
  await root.query(`CREATE DATABASE ${database}; USE ${database}`)
  await root.query(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8'))
  await root.query(`CREATE USER '${reader}'@'%' IDENTIFIED BY 'reader'; GRANT SELECT, SHOW VIEW ON ${database}.* TO '${reader}'@'%'`)

  const at = (user: string, password: string) => {
    const u = new URL(server)
    u.username = user
    u.password = password
    u.pathname = `/${database}`
    return u.href
  }
  project.provide('mysqlUpstream', at(reader, 'reader'))
  project.provide('mysqlAdmin', at(decodeURIComponent(url.username), decodeURIComponent(url.password)))

  return async () => {
    await root.query(`DROP DATABASE IF EXISTS ${database}; DROP USER IF EXISTS '${reader}'@'%'`)
    await root.end()
    await stop?.()
  }
}
