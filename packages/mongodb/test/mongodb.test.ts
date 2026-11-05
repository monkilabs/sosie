import type { Field, RequestScope } from '@sosie/core'
import { Binary, BSON, Code, DBRef, Decimal128, Double, Int32, Long, ObjectId, Timestamp, UUID, type Document } from 'bson'
import { describe, expect, it } from 'vitest'
import { fakeDocument, fromText, textOf } from '../src/fake.js'
import { plan } from '../src/guard.js'
import { msgReply, OP, opReply, readMessage } from '../src/protocol.js'
import { rewriteFilter, rewritePipeline } from '../src/rewrite.js'
import { at, collection, leaf, pipeline, projection, type Shape } from '../src/shape.js'

const same = (n: string) => n
const where = (shape: Shape, path: string) => {
  const s = leaf(at(shape, path))
  return s.kind === 'field' ? `${s.entity}.${s.path}` : s.kind
}

describe('where each value of a result comes from', () => {
  const users = collection('users')

  it('a find’s documents are its collection’s, through an inclusion or an exclusion', () => {
    expect(where(users, 'address.city')).toBe('users.address.city')
    const included = projection({ email: new Int32(1), 'address.city': 1 }, users)
    expect(where(included, 'email')).toBe('users.email')
    expect(where(included, '_id')).toBe('users._id')
    expect(where(included, 'address.city')).toBe('users.address.city')
    expect(where(projection({ e: '$email', up: { $toUpper: '$email' }, w: { $literal: 'x' } }, users), 'e')).toBe('users.email')
    expect(where(projection({ up: { $toUpper: '$email' } }, users), 'up')).toBe('computed')
    expect(where(projection({ email: 0 }, users), 'phone')).toBe('users.phone')
    // Nested, as MongoDB reads it: an inclusion of address.city, not a document holding the literal 1.
    expect(where(projection({ address: { city: 1 } }, users), 'address.city')).toBe('users.address.city')
    expect(where(projection({ address: { city: true, zip: 0 } }, users), 'address.city')).toBe('users.address.city')
    expect(where(projection({ address: { city: 0 } }, users), 'address.street')).toBe('users.address.street')
    expect(where(pipeline([{ $project: { address: { c: '$address.city' } } }], users, same), 'address.c')).toBe('users.address.city')
  })

  it('a key a stage did not name is what it was before: a $lookup keeps the document’s own fields', () => {
    const joined = pipeline([{ $lookup: { from: 'orders', localField: '_id', foreignField: 'userId', as: 'orders' } }], users, same)
    expect(where(joined, 'email')).toBe('users.email')
    expect(where(joined, 'orders.note')).toBe('orders.note')
    const unwound = pipeline([{ $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } }, { $unwind: '$user' }], collection('orders'), same)
    expect(where(unwound, 'user.email')).toBe('users.email')
    expect(where(unwound, 'note')).toBe('orders.note')
  })

  it('a group makes a document: its _id from the field it groups by, counts as counts, gathered values by their field', () => {
    const grouped = pipeline([{ $group: { _id: '$country', n: { $sum: 1 }, emails: { $push: '$email' }, avg: { $avg: '$visits' }, top: { $max: '$visits' } } }], users, same)
    expect(where(grouped, '_id')).toBe('users.country')
    expect(where(grouped, 'n')).toBe('count')
    expect(where(grouped, 'emails')).toBe('users.email')
    expect(where(grouped, 'avg')).toBe('computed')
    expect(where(grouped, 'top')).toBe('users.visits')
    expect(where(grouped, 'anything')).toBe('computed')
    expect(where(pipeline([{ $count: 'total' }], users, same), 'total')).toBe('count')
    expect(where(pipeline([{ $sortByCount: '$role' }], users, same), '_id')).toBe('users.role')
  })

  it('a union is a field only where both collections agree; a facet holds each pipeline’s shape', () => {
    const union = pipeline([{ $project: { name: '$fullName' } }, { $unionWith: { coll: 'countries', pipeline: [{ $project: { name: 1 } }] } }], users, same)
    expect(where(union, 'name')).toBe('computed')
    const faceted = pipeline([{ $facet: { a: [{ $project: { email: 1 } }], b: [{ $count: 'n' }] } }], users, same)
    expect(where(faceted, 'a.email')).toBe('users.email')
    expect(where(faceted, 'b.n')).toBe('count')
    expect(where(pipeline([{ $replaceRoot: { newRoot: '$address' } }], users, same), 'city')).toBe('users.address.city')
    expect(where(pipeline([{ $addFields: { 'address.zip': { $concat: ['a', 'b'] } } }], users, same), 'address.city')).toBe('users.address.city')
  })
})

describe('the guard', () => {
  const refused = (body: Document) => {
    const p = plan({ ...body, $db: 'app' })
    return p.kind === 'refused' ? p.refusal.errmsg : undefined
  }

  it('runs reads and answers the handshake itself', () => {
    expect(plan({ find: 'users', $db: 'app' })).toEqual({ kind: 'read', command: 'find' })
    expect(plan({ hello: 1, $db: 'admin' })).toEqual({ kind: 'local' })
    expect(plan({ listDatabases: 1, $db: 'admin' })).toEqual({ kind: 'read', command: 'listDatabases' })
  })

  it('refuses writes, MongoDB’s own databases, JavaScript on the server, and stages that write or show other sessions', () => {
    expect(refused({ insert: 'users', documents: [] })).toMatch(/read-only/)
    expect(refused({ findAndModify: 'users' })).toMatch(/read-only/)
    expect(plan({ find: 'oplog.rs', $db: 'local' })).toMatchObject({ kind: 'refused' })
    expect(plan({ find: 'system.users', $db: 'admin' })).toMatchObject({ kind: 'refused' })
    expect(refused({ find: 'system.profile' })).toMatch(/queries/)
    expect(refused({ find: 'users', filter: { $or: [{ $where: 'true' }] } })).toMatch(/\$where/)
    expect(refused({ find: 'users', filter: { x: new Code('1') } })).toMatch(/JavaScript/)
    expect(refused({ aggregate: 'users', pipeline: [], let: { f: { $function: { body: 'function() {}', args: [], lang: 'js' } } } })).toMatch(/\$function/)
    expect(refused({ find: 'users', let: { f: { $function: {} } } })).toMatch(/\$function/)
    expect(refused({ aggregate: 'users', pipeline: [{ $facet: { a: [{ $out: 'x' }] } }] })).toMatch(/\$out/)
    expect(refused({ aggregate: 'users', pipeline: [{ $lookup: { from: 'system.profile', as: 'p' } }] })).toMatch(/system\.profile/)
    expect(refused({ aggregate: 'users', pipeline: [{ $group: { _id: null, x: { $accumulator: {} } } }] })).toMatch(/\$accumulator/)
    expect(refused({ aggregate: 'users', pipeline: [{ $somethingNew: {} }] })).toMatch(/does not know the shape/)
    expect(refused({ find: 'users', startTransaction: true })).toMatch(/transactions/)
    expect(refused({ explain: { find: 'users' } })).toMatch(/explain/)
    expect(refused({ mapReduce: 'users' })).toMatch(/read-only/)
  })
})

describe('turning fakes back in a filter', () => {
  // A scope where each fake is its real value upper-cased, and records what each lookup was near.
  const near: string[] = []
  const scope = {
    lookup: (fake: string, field?: Field) => {
      near.push(field?.id ?? '')
      return fake.startsWith('fake') ? fake.toUpperCase() : undefined
    },
  } as unknown as RequestScope

  it('turns back what is compared by equality with a field, as the shape names it', () => {
    near.length = 0
    const out = rewriteFilter(
      { email: 'fake@x', 'address.city': { $in: ['fakecity', 'other'] }, $or: [{ phone: { $eq: 'fake1' } }], tags: { $elemMatch: { $eq: 'fakeTag' } }, contacts: { $elemMatch: { value: 'fakeV' } }, visits: { $gt: 'fake9' } },
      collection('users'),
      scope,
    )
    expect(out).toEqual({
      email: 'FAKE@X',
      'address.city': { $in: ['FAKECITY', 'other'] },
      $or: [{ phone: { $eq: 'FAKE1' } }],
      tags: { $elemMatch: { $eq: 'FAKETAG' } },
      contacts: { $elemMatch: { value: 'FAKEV' } },
      visits: { $gt: 'fake9' },
    })
    expect(near).toEqual(expect.arrayContaining(['users.email', 'users.address.city', 'users.phone', 'users.tags', 'users.contacts.value']))
  })

  it('keeps a value’s type: an ObjectId turned back is an ObjectId', () => {
    const idScope = { lookup: () => '64b7f0c2a1b2c3d4e5f60001' } as unknown as RequestScope
    const out = rewriteFilter({ _id: new ObjectId('0123456789abcdef01234567') }, collection('users'), idScope) as Document
    expect(out._id).toBeInstanceOf(ObjectId)
    expect(out._id.toHexString()).toBe('64b7f0c2a1b2c3d4e5f60001')
  })

  it('turns back a $match in a $unionWith’s pipeline, and a $graphLookup’s restriction, against their collections', () => {
    near.length = 0
    const [union, graph] = rewritePipeline(
      [
        { $unionWith: { coll: 'admins', pipeline: [{ $match: { email: 'fake@x' } }] } },
        { $graphLookup: { from: 'people', startWith: '$boss', connectFromField: 'boss', connectToField: '_id', as: 'chain', restrictSearchWithMatch: { email: 'fake@y' } } },
      ],
      collection('users'),
      scope,
      same,
    )
    expect(union).toEqual({ $unionWith: { coll: 'admins', pipeline: [{ $match: { email: 'FAKE@X' } }] } })
    expect((graph as Document).$graphLookup.restrictSearchWithMatch).toEqual({ email: 'FAKE@Y' })
    expect(near).toEqual(['admins.email', 'people.email'])
  })

  it('turns back a $match after a $group against what the group made', () => {
    near.length = 0
    const [, match] = rewritePipeline([{ $group: { _id: '$email', n: { $sum: 1 } } }, { $match: { _id: 'fake@x' } }], collection('users'), scope, same)
    expect(match).toEqual({ $match: { _id: 'FAKE@X' } })
    expect(near).toEqual(['users.email'])
  })
})

describe('BSON values as the core fakes them', () => {
  it('reads each type as text and writes a fake back in the same type', () => {
    const values: unknown[] = [
      'x',
      true,
      new Int32(5),
      Long.fromString('9007199254740993'),
      new Double(2.5),
      Decimal128.fromString('1.25'),
      new ObjectId('64b7f0c2a1b2c3d4e5f60001'),
      new Date('2025-01-02T03:04:05.678Z'),
      new UUID('d3adb33f-0000-4000-8000-c0ffee000001'),
      new Binary(Buffer.from([1, 2, 3])),
      new Timestamp({ t: 1_700_000_000, i: 3 }),
    ]
    for (const value of values) {
      const known = textOf(value)!
      const back = fromText(known.text, value)
      expect(BSON.serialize({ v: back })).toEqual(BSON.serialize({ v: value }))
    }
    expect(textOf(new ObjectId('64b7f0c2a1b2c3d4e5f60001'))).toEqual({ text: '64b7f0c2a1b2c3d4e5f60001', type: { kind: 'objectid' } })
    expect(textOf(new Binary(Buffer.from([0xde, 0xad])))).toEqual({ text: '\\xdead', type: { kind: 'bytes' } })
    expect(fromText('not a number', new Int32(1))).toBeNull()
  })

  it('fakes a document: a key that is a value faked, a reference’s collection kept and its id faked', () => {
    const faker = {
      value: (v: string, field: Field) => (field.id === '$key' ? `key-${v.length}` : field.type.kind === 'objectid' ? 'ffffffffffffffffffffffff' : `f(${v})`),
      computed: (v: string) => `c(${v})`,
    }
    const met: string[] = []
    const out = fakeDocument(
      { email: 'a@b', 'quill@x.test': 1, ref: new DBRef('users', new ObjectId('64b7f0c2a1b2c3d4e5f60001'), undefined, { note: 'real' }) },
      collection('users'),
      { faker: faker as never, scope: undefined, sent: '', met: (e, p) => met.push(`${e}.${p}`) },
    )
    expect(out.email).toBe('f(a@b)')
    expect(Object.keys(out)).toContain('key-12')
    expect(out.ref).toBeInstanceOf(DBRef)
    expect(out.ref.collection).toBe('users')
    expect(out.ref.oid.toHexString()).toBe('ffffffffffffffffffffffff')
    expect(out.ref.fields).toEqual({ note: 'f(real)' })
    expect(met).toContain('users.email')
  })

  it('fakes a key a stage made from values, keeping the keys the client wrote and MongoDB’s own', () => {
    const faker = { value: (v: string) => `key-${v}`, computed: (v: string) => v }
    const ctx = { faker: faker as never, scope: undefined, sent: '{"aggregate":"users","pipeline":[{"$project":{"total":1}}]}', met: () => {} }
    const computed: Shape = { kind: 'computed' }
    const out = fakeDocument({ admin: 1, total: 2, k: 'x', v: 3 }, computed, ctx)
    expect(Object.keys(out)).toEqual(['key-admin', 'total', 'k', 'v'])
    // In a collection's own documents, a key that looks like a word is a field's name.
    expect(Object.keys(fakeDocument({ admin: 1 }, collection('users'), ctx))).toEqual(['admin'])
  })
})

describe('the wire protocol', () => {
  const frame = (opCode: number, body: Buffer) => {
    const header = Buffer.alloc(16)
    header.writeInt32LE(16 + body.length, 0)
    header.writeInt32LE(7, 4)
    header.writeInt32LE(opCode, 12)
    return Buffer.concat([header, body])
  }

  it('reads OP_MSG: its body, a document sequence set on it, a checksum after', () => {
    const body = BSON.serialize({ insert: 'users', $db: 'app' })
    const docs = [BSON.serialize({ a: 1 }), BSON.serialize({ a: 2 })]
    const id = Buffer.from('documents\0')
    const size = Buffer.alloc(4)
    size.writeInt32LE(4 + id.length + docs[0]!.length + docs[1]!.length)
    const flags = Buffer.alloc(4)
    flags.writeUInt32LE(1)
    const message = readMessage(frame(OP.MSG, Buffer.concat([flags, Buffer.from([0]), body, Buffer.from([1]), size, id, ...docs, Buffer.alloc(4)])))
    expect(message.requestId).toBe(7)
    expect(message.body.insert).toBe('users')
    expect(message.body.documents).toHaveLength(2)
  })

  it('reads OP_QUERY’s first hello, and answers each in its own form', () => {
    const query = Buffer.concat([Buffer.alloc(4), Buffer.from('admin.$cmd\0'), Buffer.alloc(8), BSON.serialize({ isMaster: 1 })])
    const message = readMessage(frame(OP.QUERY, query))
    expect(message.namespace).toBe('admin.$cmd')
    expect(message.body).toEqual({ isMaster: new Int32(1) })
    const msg = msgReply(7, { ok: 1 })
    expect(msg.readInt32LE(0)).toBe(msg.length)
    expect(msg.readInt32LE(8)).toBe(7)
    expect(msg.readInt32LE(12)).toBe(OP.MSG)
    const reply = opReply(7, { ok: 1 })
    expect(reply.readInt32LE(12)).toBe(OP.REPLY)
    expect(reply.readInt32LE(32)).toBe(1)
  })
})
