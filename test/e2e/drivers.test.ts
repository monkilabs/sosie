import { execFile, spawnSync } from 'node:child_process'
import { count, eq, inArray } from 'drizzle-orm'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { integer, numeric, pgTable, serial, text, varchar, bigserial } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js'
import postgresJs from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canariesIn } from './canaries.js'
import { startSosie, type Started } from './sosie.js'

/** Everything the drivers got back, searched for canaries at the end. */
const seen: unknown[] = []
let sosie: Started

beforeAll(async () => {
  sosie = await startSosie()
})
afterAll(async () => {
  await sosie.close()
  expect(canariesIn(JSON.stringify(seen))).toEqual([])
})

describe('postgres.js', () => {
  it('reads, and finds rows by fakes in its prepared statements', async () => {
    const sql = postgresJs(sosie.address, { max: 1, onnotice: () => {} })
    const users = await sql`SELECT id, email, tags FROM users ORDER BY id LIMIT 3`
    expect(users).toHaveLength(3)
    const [one] = await sql`SELECT email FROM users WHERE id = ${users[1]!.id}`
    expect(one!.email).toBe(users[1]!.email)
    const [two] = await sql`SELECT id FROM users WHERE email = ${users[2]!.email}`
    expect(two!.id).toBe(users[2]!.id)
    const many = await sql`SELECT id FROM users WHERE id IN ${sql(users.map((u) => u.id))}`
    expect(many).toHaveLength(3)
    const refused = await sql`DELETE FROM users`.catch((e: { code: string }) => e)
    expect(refused).toMatchObject({ code: '25006' })
    seen.push(users, one, two, many)
    await sql.end()
  })
})

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 120 }),
  fullName: text('full_name').notNull(),
})
const orders = pgTable('orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull(),
  status: text('status').notNull(),
  total: numeric('total').notNull(),
})

describe('Drizzle', () => {
  it.each([
    ['node-postgres', async () => drizzlePg(sosie.address)],
    ['postgres.js', async () => drizzlePostgresJs(postgresJs(sosie.address, { max: 1, onnotice: () => {} }))],
  ])('works unchanged over %s', async (_, open) => {
    const db = await open()
    const list = await db.select().from(users).orderBy(users.id).limit(3)
    expect(list).toHaveLength(3)
    const [found] = await db.select({ email: users.email }).from(users).where(eq(users.id, list[1]!.id))
    expect(found!.email).toBe(list[1]!.email)
    const [byEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, list[0]!.email!))
    expect(byEmail!.id).toBe(list[0]!.id)
    const some = await db.select({ id: users.id }).from(users).where(inArray(users.id, [list[0]!.id, list[2]!.id]))
    expect(some).toHaveLength(2)
    const joined = await db.select({ uid: users.id, owner: orders.userId }).from(orders).innerJoin(users, eq(users.id, orders.userId))
    expect(joined).toHaveLength(5)
    for (const row of joined) expect(row.owner).toBe(row.uid)
    const [total] = await db.select({ n: count() }).from(orders)
    expect(total!.n).toBe(5)
    seen.push(list, found, byEmail, some, joined)
    await (db.$client as { end(): Promise<void> }).end()
  })
})

const PSQL = process.env.PSQL ?? 'psql'
const hasPsql = spawnSync(PSQL, ['--version']).status === 0

// Skipped where psql is missing, except in CI, where a skip would hide a regression.
describe.skipIf(!hasPsql && !process.env.CI)('psql', () => {
  // Sosie runs in this process, so psql must not block it.
  const psql = (command: string) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(PSQL, [sosie.address, '-X', '-A', '-t', '-c', command], { env: { ...process.env, PGCONNECT_TIMEOUT: '5' } }, (error, stdout, stderr) => {
        seen.push(stdout, stderr)
        resolve({ status: error ? Number(error.code ?? 1) : 0, stdout, stderr })
      })
    })

  it('reads', async () => {
    const result = await psql('SELECT email FROM users ORDER BY id LIMIT 2')
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toHaveLength(2)
    expect(result.stdout).toMatch(/@example\.(com|net|org)/)
  })

  it('describes tables with \\d, from the catalogs', async () => {
    const result = await psql('\\d users')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('email|character varying(120)')
    expect(result.stdout).toContain('full_name|text')
    expect((await psql('\\dt')).stdout).toContain('|users|table|')
  })

  it('shows refusals and the row cap', async () => {
    expect((await psql('DELETE FROM users')).stderr).toContain('ERROR:  This statement changes data. Sosie is read-only.')
    expect((await psql('SELECT * FROM events')).stderr).toContain('NOTICE:  Sosie returned the first 100 rows')
  })
})

describe('canaries', () => {
  it('never came out', () => {
    expect(canariesIn(JSON.stringify(seen))).toEqual([])
  })
})
