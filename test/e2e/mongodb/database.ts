import { MongoClient } from 'mongodb'
import type { TestProject } from 'vitest/node'
import { seed } from './seed.js'

declare module 'vitest' {
  export interface ProvidedContext {
    /** A login with the read role on the seeded database: what a developer gives Sosie. */
    mongodbUpstream: string
    /** A login that can do anything: for checks Sosie must not affect, and a login that can write. */
    mongodbAdmin: string
  }
}

/**
 * MongoDB for the end-to-end tests: SOSIE_TEST_MONGODB_URL when set (CI runs MongoDB 6.0, 7.0 and 8.0 that way), a
 * root login on a server; or one started here from MongoDB's own binaries, cached after the first run.
 */
export default async function setup(project: TestProject) {
  let server = process.env.SOSIE_TEST_MONGODB_URL
  let stop: (() => Promise<unknown>) | undefined
  if (!server) {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const memory = await MongoMemoryServer.create({ auth: { enable: true, customRootName: 'root', customRootPwd: 'root' } })
    const url = new URL(memory.getUri())
    server = `mongodb://root:root@${url.host}/?authSource=admin`
    stop = () => memory.stop()
  }
  const suffix = `${process.pid}_${Date.now() % 100000}`
  const database = `sosie_test_${suffix}`
  const reader = `sosie_reader_${suffix}`
  // Heartbeats that poll: a client closed while a streamed hello waits throws inside vitest's stack mapper.
  const root = new MongoClient(server, { serverMonitoringMode: 'poll' })
  await root.connect()
  const db = root.db(database)
  await seed(db)
  await db.command({ createUser: reader, pwd: 'reader', roles: [{ role: 'read', db: database }] })

  const host = new URL(server).host
  project.provide('mongodbUpstream', `mongodb://${reader}:reader@${host}/${database}`)
  project.provide('mongodbAdmin', `mongodb://root:root@${host}/${database}?authSource=admin`)

  return async () => {
    await db.command({ dropUser: reader }).catch(() => {})
    await db.dropDatabase().catch(() => {})
    await root.close()
    await stop?.()
  }
}
