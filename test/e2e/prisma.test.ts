import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canariesIn } from './canaries.js'
import { startSosie, type Started } from './sosie.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the client is generated when the test runs. */
let sosie: Started
let prisma: any
const seen: unknown[] = []

beforeAll(async () => {
  const schema = fileURLToPath(new URL('./prisma/schema.prisma', import.meta.url))
  const prismaCli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url))
  const generate = spawnSync(process.execPath, [prismaCli, 'generate', '--schema', schema], { encoding: 'utf8' })
  if (generate.status !== 0) throw new Error(generate.stderr)
  sosie = await startSosie()
  const client = './prisma/generated/client.js'
  const { PrismaClient } = await import(/* @vite-ignore */ client)
  const { PrismaPg } = await import('@prisma/adapter-pg')
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: sosie.address }) })
})

afterAll(async () => {
  await prisma?.$disconnect()
  await sosie?.close()
})

describe('Prisma, through its node-postgres adapter', () => {
  it('reads, filters by fakes and counts, unchanged', async () => {
    const users = await prisma.user.findMany({ take: 3, orderBy: { id: 'asc' } })
    expect(users).toHaveLength(3)
    expect(await prisma.user.findUnique({ where: { id: users[1].id } })).toEqual(users[1])
    expect((await prisma.user.findFirst({ where: { email: users[2].email } })).id).toBe(users[2].id)
    expect(await prisma.user.findMany({ where: { id: { in: [users[0].id, users[2].id] } } })).toHaveLength(2)
    expect(await prisma.order.count()).toBe(5)
    seen.push(users)
  })

  it('loads relations that hold together', async () => {
    const users = await prisma.user.findMany({ include: { orders: true }, where: { orders: { some: {} } } })
    expect(users.length).toBeGreaterThan(0)
    for (const user of users) for (const order of user.orders) expect(order.userId).toBe(user.id)
    const orders = await prisma.order.findMany({ include: { user: true } })
    for (const order of orders) expect(order.user.id).toBe(order.userId)
    seen.push(JSON.stringify(users, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
  })

  it('reports Sosie’s refusals as errors', async () => {
    await expect(prisma.user.deleteMany({})).rejects.toThrow(/Sosie is read-only/)
  })

  it('let no canary out', () => {
    expect(canariesIn(JSON.stringify(seen))).toEqual([])
  })
})
