import { Binary, Decimal128, Double, Int32, Long, ObjectId, UUID, type Db } from 'mongodb'

/** The ids the seed uses, fixed so a test can name a document. */
export const IDS = {
  quill: new ObjectId('64b7f0c2a1b2c3d4e5f60001'),
  zephyrine: new ObjectId('64b7f0c2a1b2c3d4e5f60002'),
}

/**
 * The canary people of the SQL seeds, as MongoDB documents: nested, in arrays, and under every BSON type a value
 * can have. Orders refer to users by ObjectId, as MongoDB applications do.
 */
export async function seed(db: Db): Promise<void> {
  await db.collection('countries').insertMany([
    { _id: 'CZ' as never, name: 'Czechia' },
    { _id: 'SK' as never, name: 'Slovakia' },
    { _id: 'AT' as never, name: 'Austria' },
  ])
  const people = [
    {
      _id: IDS.quill,
      email: 'quill.vantablack@canary-mail.test',
      fullName: 'Quillon Vantablack',
      phone: '+420 777 912 345',
      address: { city: 'Vantaville', street: '12 Obsidian Row' },
      apiKey: 'sk_live_9Qv7Xc2Lm8Rt',
      account: '7739182046',
      active: true,
      role: 'admin',
      createdAt: new Date('2025-03-14T09:26:53.589Z'),
      visits: new Int32(42),
      balance: Long.fromString('9007199254740993'),
      score: Decimal128.fromString('1234.56'),
      rating: new Double(4.5),
      avatar: new Binary(Buffer.from('deadbeef', 'hex')),
      externalId: new UUID('d3adb33f-0000-4000-8000-c0ffee000001'),
      tags: ['vip', 'Vantaville'],
      contacts: [{ kind: 'email', value: 'quill.vantablack@canary-mail.test' }],
      country: 'CZ',
    },
    {
      _id: IDS.zephyrine,
      email: 'zephyrine@orrowmoor.test',
      fullName: 'Zephyrine Orrowmoor',
      phone: '+421 905 111 222',
      address: { city: 'Orrowmoor', street: '7 Fen Lane' },
      apiKey: 'sk_live_Zz8yYx7wWv6u',
      account: '5512093377',
      active: false,
      role: 'editor',
      createdAt: new Date('2024-11-02T18:00:00.000Z'),
      visits: new Int32(7),
      balance: Long.fromNumber(12),
      score: Decimal128.fromString('99.90'),
      rating: new Double(3),
      avatar: new Binary(Buffer.from('00ff', 'hex')),
      externalId: new UUID('d3adb33f-0000-4000-8000-c0ffee000002'),
      tags: ['Orrowmoor'],
      contacts: [],
      country: 'SK',
    },
  ]
  const others = Array.from({ length: 38 }, (_, i) => {
    const n = i + 3
    return {
      _id: new ObjectId(`64b7f0c2a1b2c3d4e5f6${String(n).padStart(4, '0')}`),
      email: `person${n}@example.org`,
      fullName: `Person ${n}`,
      phone: `+1 555 0100 ${n}`,
      address: { city: 'Springfield', street: `${n} Main St` },
      active: n % 2 === 0,
      role: ['admin', 'editor', 'viewer'][n % 3],
      createdAt: new Date(Date.UTC(2025, 0, n)),
      visits: new Int32(n),
      tags: [],
      country: 'AT',
    }
  })
  await db.collection('users').insertMany([...people, ...others] as never[])
  await db.createCollection('active_users', { viewOn: 'users', pipeline: [{ $match: { active: true } }, { $project: { email: 1, fullName: 1 } }] })
  await db.collection('orders').insertMany([
    { userId: IDS.quill, status: 'paid', total: Decimal128.fromString('120.50'), note: 'leave the parcel with Quillon', placedAt: new Date('2025-04-01T10:00:00Z'), items: [{ sku: 'A-1', qty: new Int32(2) }] },
    { userId: IDS.quill, status: 'new', total: Decimal128.fromString('9.99'), note: 'ring twice', placedAt: new Date('2025-04-02T11:30:00Z'), items: [] },
    { userId: IDS.zephyrine, status: 'shipped', total: Decimal128.fromString('1500.00'), note: null, placedAt: new Date('2025-04-03T12:00:00Z'), items: [{ sku: 'B-7', qty: new Int32(1) }] },
    { userId: new ObjectId('64b7f0c2a1b2c3d4e5f60003'), status: 'paid', total: Decimal128.fromString('42.00'), note: 'gift', placedAt: new Date('2025-04-04T13:15:00Z'), items: [] },
    { userId: new ObjectId('64b7f0c2a1b2c3d4e5f60003'), status: 'cancelled', total: Decimal128.fromString('7.00'), note: null, placedAt: new Date('2025-04-05T14:45:00Z'), items: [] },
  ])
}
