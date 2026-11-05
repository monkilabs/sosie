import { MongoClient } from 'mongodb'
import type { TestProject } from 'vitest/node'
import { seed } from './seed.js'

/**
 * A client of the server, once it takes the login: a container just started makes its root user after it listens.
 * Heartbeats poll, since a client closed while a streamed hello waits throws inside vitest's stack mapper.
 */
async function connectWithin(server: string, ms: number): Promise<MongoClient> {
  const until = Date.now() + ms
  for (;;) {
    const client = new MongoClient(server, { serverMonitoringMode: 'poll', serverSelectionTimeoutMS: 5000 })
    try {
      await client.connect()
      await client.db('admin').command({ ping: 1 })
      return client
    } catch (error) {
      await client.close().catch(() => {})
      if (Date.now() > until) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

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
  const root = await connectWithin(server, 60_000)
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
