import { Binary, BSON, Decimal128, Double, Int32, Long, MongoClient, ObjectId, type Db, type Document } from 'mongodb'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { canariesIn } from '../canaries.js'
import { IDS } from './seed.js'
import { startSosie } from './sosie.js'

let sosie: Awaited<ReturnType<typeof startSosie>>
let db: Db
let truthClient: MongoClient
let truth: Db
/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []
const keep = <T>(value: T): T => {
  seen.push(value)
  return value
}

const all = async (collection: string, filter: Document = {}, options: Document = {}) => keep(await db.collection(collection).find(filter, options).toArray())
const aggregate = async (collection: string, pipeline: Document[]) => keep(await db.collection(collection).aggregate(pipeline).toArray())
const refused = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    seen.push((error as Error).message)
    return error as { code: number; message: string }
  }
  throw new Error('expected it to be refused')
}

beforeAll(async () => {
  sosie = await startSosie()
  db = (await sosie.client()).db()
  truthClient = new MongoClient(inject('mongodbUpstream'), { serverMonitoringMode: 'poll' })
  await truthClient.connect()
  truth = truthClient.db()
})

afterAll(async () => {
  await truthClient?.close()
  await sosie?.close()
  const text = BSON.EJSON.stringify(seen, { relaxed: false })
  expect(canariesIn(text)).toEqual([])
  // The seed's ObjectIds are real values too.
  for (const id of Object.values(IDS)) expect(text).not.toContain(id.toHexString())
})

describe('reading through Sosie', () => {
  it('returns every document, every value faked, each in its own BSON type', async () => {
    const users = await all('users', {}, { sort: { _id: 1 } })
    const real = await truth.collection('users').find({}, { sort: { _id: 1 } }).toArray()
    expect(users).toHaveLength(real.length)
    const first = users.find((u) => u.score instanceof Decimal128)!
    expect(first._id).toBeInstanceOf(ObjectId)
    expect(first.email).toMatch(/@example\.(com|net|org)$/)
    expect(first.score).toBeInstanceOf(Decimal128)
    // The driver gives a Long that fits a number as one.
    expect(typeof first.balance === 'number' || first.balance instanceof Long).toBe(true)
    expect(first.createdAt).toBeInstanceOf(Date)
    expect(first.avatar).toBeInstanceOf(Binary)
    expect(first.externalId).toBeInstanceOf(Binary)
    expect(first.externalId.sub_type).toBe(Binary.SUBTYPE_UUID)
    expect(typeof first.active).toBe('boolean')
    expect(first.address).toEqual({ city: expect.any(String), street: expect.any(String) })
  })

  it('fakes a field a nested projection names, as a dotted one', async () => {
    const dotted = await all('users', {}, { projection: { 'address.city': 1 }, sort: { _id: 1 } })
    const nested = await all('users', {}, { projection: { address: { city: 1 } }, sort: { _id: 1 } })
    const projected = await aggregate('users', [{ $sort: { _id: 1 } }, { $project: { address: { city: true } } }])
    expect(nested).toEqual(dotted)
    expect(projected).toEqual(dotted)
    expect(canariesIn(JSON.stringify([nested, projected]))).toEqual([])
  })

  it('keeps BSON’s numbers as they are: an Int32 an Int32, a Double a Double', async () => {
    const raw = await db.collection('users').find({}, { promoteValues: false, sort: { _id: 1 }, limit: 2 }).toArray()
    keep(raw)
    expect(raw[0]!.visits).toBeInstanceOf(Int32)
    expect(raw[0]!.rating).toBeInstanceOf(Double)
    expect(raw[0]!.balance).toBeInstanceOf(Long)
  })

  it('keeps references: an ObjectId is the same fake wherever it is held', async () => {
    const users = await all('users')
    const orders = await all('orders')
    const ids = new Set(users.map((u) => u._id.toHexString()))
    for (const order of orders) expect(ids.has(order.userId.toHexString())).toBe(true)
    const joined = await aggregate('orders', [
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { userId: 1, 'user._id': 1, 'user.email': 1 } },
    ])
    expect(joined).toHaveLength(5)
    for (const order of joined) {
      expect(order.user._id.equals(order.userId)).toBe(true)
      expect(users.find((u) => u._id.equals(order.userId))!.email).toBe(order.user.email)
    }
  })

  it('fakes each value of a pipeline by where it came from: a field’s by its field, what it computes by type', async () => {
    const [first] = await all('users', {}, { sort: { _id: 1 }, limit: 1 })
    const [renamed] = await aggregate('users', [
      { $match: { _id: first!._id } },
      { $project: { _id: 0, e: '$email', city: '$address.city', upper: { $toUpper: '$fullName' }, word: { $literal: 'hello' } } },
    ])
    expect(renamed!.e).toBe(first!.email)
    expect(renamed!.city).toBe(first!.address.city)
    expect(renamed!.upper).not.toBe(first!.fullName.toUpperCase())
    expect(renamed!.word).toBe('hello')
    // A count passes; the values a group gathers are faked by their field.
    const groups = await aggregate('users', [{ $group: { _id: '$country', n: { $sum: 1 }, emails: { $push: '$email' } } }])
    expect(groups.map((g) => g.n).sort((a, b) => a - b)).toEqual([1, 1, 38])
    expect(groups.flatMap((g) => g.emails)).toContain(first!.email)
    expect(await aggregate('users', [{ $match: { active: true } }, { $count: 'total' }])).toEqual([{ total: 20 }])
    expect(await db.collection('users').countDocuments({ active: false })).toBe(20)
  })

  it('fakes a view’s fields as its collection’s, through the view’s pipeline', async () => {
    // Not { active: true }: a boolean is faked too, so that filter may mean the real false.
    const users = await all('users')
    const view = await all('active_users')
    expect(view).toHaveLength(20)
    for (const doc of view) expect(users.find((u) => u._id.equals(doc._id))?.email).toBe(doc.email)
    const [first] = view
    expect((await all('active_users', { email: first!.email }))[0]!._id.equals(first!._id)).toBe(true)
  })

  it('learns each field from the documents, for describe', async () => {
    await all('orders', {}, { limit: 1 })
    await new Promise((r) => setTimeout(r, 700))
    const latest = sosie.learned.at(-1)!
    const orders = latest.entities.find((e) => e.id === 'orders')!
    expect(orders.fields.map((f) => f.id)).toEqual(expect.arrayContaining(['orders._id', 'orders.userId', 'orders.total', 'orders.items.sku']))
    expect(orders.fields.find((f) => f.id === 'orders.userId')!.type).toEqual({ kind: 'objectid' })
  })
})

describe('querying by what you saw', () => {
  it('finds a document by a fake email, _id or reference, alone, in $in, $eq and $elemMatch', async () => {
    const [first] = await all('users', { tags: { $size: 2 } })
    const byEmail = await db.collection('users').findOne({ email: first!.email })
    const byId = await db.collection('users').findOne({ _id: first!._id })
    const byIn = await all('users', { email: { $in: [first!.email, 'nobody@example.com'] } })
    const byEq = await all('users', { 'address.city': { $eq: first!.address.city }, _id: first!._id })
    const byElem = await all('users', { contacts: { $elemMatch: { value: first!.contacts[0].value } } })
    for (const doc of [byEmail, byId, byIn[0], byEq[0], byElem[0]]) expect(doc!.fullName).toBe(first!.fullName)
    keep([byEmail, byId])
    expect(await db.collection('orders').countDocuments({ userId: first!._id })).toBe(2)
    expect(await db.collection('orders').distinct('status', { userId: first!._id })).toHaveLength(2)
  })

  it('turns back a $match after a $group by what the group made', async () => {
    const [first] = await all('users', { tags: { $size: 2 } })
    const groups = await aggregate('users', [{ $group: { _id: '$email', n: { $sum: 1 } } }, { $match: { _id: first!.email } }])
    expect(groups).toEqual([{ _id: first!.email, n: 1 }])
  })
})

describe('the guard', () => {
  it.each([
    ['insertOne', () => db.collection('users').insertOne({ x: 1 })],
    ['updateOne', () => db.collection('users').updateOne({}, { $set: { x: 1 } })],
    ['deleteMany', () => db.collection('users').deleteMany({})],
    ['drop', () => db.collection('orders').drop()],
    ['createIndex', () => db.collection('users').createIndex({ x: 1 })],
    ['$out', () => db.collection('users').aggregate([{ $out: 'copy' }]).toArray()],
    ['$merge', () => db.collection('users').aggregate([{ $merge: { into: 'copy' } }]).toArray()],
    ['$where', () => db.collection('users').find({ $where: 'true' }).toArray()],
    ['$function', () => db.collection('users').aggregate([{ $addFields: { x: { $function: { body: 'function() { return 1 }', args: [], lang: 'js' } } } }]).toArray()],
    ['explain', () => db.collection('users').find({}).explain()],
    ['the admin database', () => db.client.db('admin').collection('system.users').find().toArray()],
    ['the local database', () => db.client.db('local').collection('oplog.rs').find().toArray()],
    ['system.profile', () => db.collection('system.profile').find().toArray()],
    ['$currentOp', () => db.client.db('admin').aggregate([{ $currentOp: {} }]).toArray()],
  ])('refuses %s, and says why', async (_, work) => {
    const error = await refused(work())
    expect(error.message).toMatch(/Sosie|read-only/)
  })

  it('runs no transaction', async () => {
    const client = db.client
    const session = client.startSession()
    try {
      session.startTransaction()
      const error = await refused(db.collection('users').findOne({}, { session }))
      expect(error.message).toMatch(/transactions/)
    } finally {
      await session.endSession()
    }
  })

  it('warns of a login that can write, and still writes nothing', async () => {
    const admin = await startSosie({ upstream: inject('mongodbAdmin') })
    expect(admin.warnings.join(' ')).toMatch(/administrator|can change data/)
    const other = (await admin.client()).db()
    expect((await refused(other.collection('users').insertOne({ x: 1 }))).code).toBe(13)
    await admin.close()
    expect(await truth.collection('users').countDocuments({ x: 1 })).toBe(0)
  })

  it('answers the handshake itself, and takes no login', async () => {
    const hello = await db.admin().command({ hello: 1 })
    expect(hello.isWritablePrimary).toBe(true)
    expect(hello.setName).toBeUndefined()
    const withLogin = new MongoClient(sosie.address.replace('mongodb://', 'mongodb://kim:secret@'), { serverSelectionTimeoutMS: 3000 })
    await expect(withLogin.connect()).rejects.toThrow(/takes no login/)
    await withLogin.close()
  })
})

describe('cursors and limits', () => {
  it('reads a cursor in batches, and closes one the client closes', async () => {
    const cursor = db.collection('users').find().batchSize(7)
    let n = 0
    for await (const doc of cursor) {
      keep(doc)
      n++
    }
    expect(n).toBe(40)
    const open = db.collection('users').find().batchSize(2)
    await open.next()
    await open.close()
  })

  it('cuts a cursor at the cap on rows', async () => {
    const capped = await startSosie({ maxRows: 5 })
    const docs = keep(await (await capped.client()).db().collection('users').find().batchSize(2).toArray())
    expect(docs).toHaveLength(5)
    await capped.close()
  })
})

describe('errors', () => {
  it('shows an error about the command, and only the code of one that may quote a value', async () => {
    const stage = await refused(db.collection('users').aggregate([{ $nope: {} }]).toArray())
    expect(stage.message).toMatch(/Sosie does not run \$nope/)
    const unknown = await refused(db.collection('users').find({ email: { $nope: 1 } }).toArray())
    expect(unknown.message).toMatch(/unknown operator: \$nope/)
    // $toInt quotes the value it could not convert.
    const conversion = await refused(db.collection('users').aggregate([{ $project: { x: { $toInt: '$email' } } }]).toArray())
    expect(conversion.message).toMatch(/Sosie hides the rest of this message/)
  })

  it('stops a command at the time limit it was started with', async () => {
    const slow = await startSosie({ statementTimeout: 50 })
    const other = (await slow.client()).db()
    // Nine million documents made from nothing, and counted: about 200 ms, far past 50.
    const error = await refused(
      other
        .aggregate([
          { $documents: [{}] },
          { $project: { a: { $range: [0, 3000] } } },
          { $unwind: '$a' },
          { $project: { b: { $range: [0, 3000] } } },
          { $unwind: '$b' },
          { $group: { _id: null, n: { $sum: 1 } } },
        ])
        .toArray(),
    )
    expect(error.code).toBe(50)
    await slow.close()
  })
})
