import type { Schema, Value } from '@sosie/core'
import type { MemoryData } from './source.js'

/** Values that must never come out of Sosie. Each is unique enough to search for. */
export const CANARIES = {
  email: 'quill.vantablack@canary-mail.test',
  name: 'Quillon Vantablack',
  phone: '+420 777 912 345',
  city: 'Vantaville',
  apiKey: 'sk_live_9Qv7Xc2Lm8Rt',
  orderNote: 'leave the parcel with Quillon',
  accountNumber: '7739182046',
} as const

export const schema: Schema = {
  entities: [
    {
      id: 'users',
      name: 'users',
      fields: [
        { id: 'users.id', name: 'id', type: { kind: 'integer', bytes: 4 }, key: 'primary' },
        { id: 'users.email', name: 'email', type: { kind: 'string', maxLength: 120 }, key: 'unique' },
        { id: 'users.name', name: 'name', type: { kind: 'string' } },
        { id: 'users.phone', name: 'phone', type: { kind: 'string' } },
        { id: 'users.city', name: 'city', type: { kind: 'string' } },
        { id: 'users.api_key', name: 'api_key', type: { kind: 'string' } },
        { id: 'users.active', name: 'active', type: { kind: 'boolean' } },
        { id: 'users.role', name: 'role', type: { kind: 'enum', labels: ['admin', 'editor', 'viewer'] } },
        { id: 'users.created_at', name: 'created_at', type: { kind: 'datetime' } },
        { id: 'users.profile', name: 'profile', type: { kind: 'json' } },
        { id: 'users.tags', name: 'tags', type: { kind: 'array', of: { kind: 'string' } } },
        { id: 'users.last_ip', name: 'last_ip', type: { kind: 'ip' } },
        { id: 'users.avatar', name: 'avatar', type: { kind: 'bytes' } },
        { id: 'users.score', name: 'score', type: { kind: 'decimal' } },
        { id: 'users.account', name: 'account', type: { kind: 'string' } },
        { id: 'users.uid', name: 'uid', type: { kind: 'uuid' } },
        { id: 'users.born_on', name: 'born_on', type: { kind: 'date' } },
        { id: 'users.wakes_at', name: 'wakes_at', type: { kind: 'time' } },
        { id: 'users.shape', name: 'shape', type: { kind: 'unknown' } },
      ],
    },
    {
      id: 'orders',
      name: 'orders',
      fields: [
        { id: 'orders.id', name: 'id', type: { kind: 'integer', bytes: 4 }, key: 'primary' },
        { id: 'orders.user_id', name: 'user_id', type: { kind: 'integer', bytes: 4 }, references: 'users.id' },
        { id: 'orders.contact_email', name: 'contact_email', type: { kind: 'string' } },
        { id: 'orders.total', name: 'total', type: { kind: 'decimal' } },
        { id: 'orders.status', name: 'status', type: { kind: 'enum', labels: ['new', 'paid', 'shipped'] } },
        { id: 'orders.note', name: 'note', type: { kind: 'string' } },
        { id: 'orders.country', name: 'country', type: { kind: 'string' }, references: 'countries.code' },
      ],
    },
    {
      id: 'countries',
      name: 'countries',
      fields: [
        { id: 'countries.code', name: 'code', type: { kind: 'string', maxLength: 2 }, key: 'primary' },
        { id: 'countries.name', name: 'name', type: { kind: 'string' } },
      ],
    },
  ],
}

const user = (id: number, email: string, name: string, extra: Record<string, Value> = {}): Record<string, Value> => ({
  id: String(id),
  email,
  name,
  phone: '+1 555 010 ' + String(1000 + id),
  city: 'Springfield',
  api_key: `sk_test_${id}abcDEF123`,
  active: id % 2 ? 't' : 'f',
  role: ['admin', 'editor', 'viewer'][id % 3]!,
  created_at: '2025-03-14 09:26:53.589+01',
  profile: JSON.stringify({ email, nickname: `nick${id}`, visits: id * 3, vip: id === 1, address: { city: 'Brno' } }),
  tags: ['early', `tag${id}`, null],
  last_ip: `10.0.0.${id}`,
  avatar: '\\x' + 'ab'.repeat(id + 1),
  score: `${id}23.45`,
  account: `ACC-${100000 + id}`,
  uid: `0f8fad5b-d9cb-469f-a165-70867728950${id}`,
  born_on: '1990-07-0' + String(id),
  wakes_at: '06:3' + String(id) + ':00',
  shape: '(1,2)',
  ...extra,
})

export const data: MemoryData = {
  schema,
  rows: {
    users: [
      user(1, CANARIES.email, CANARIES.name, {
        phone: CANARIES.phone,
        city: CANARIES.city,
        api_key: CANARIES.apiKey,
        account: CANARIES.accountNumber,
      }),
      user(2, 'jan.novak@firma.cz', 'Jan Novák'),
      user(3, 'eva.svobodova@firma.cz', 'Eva Svobodová'),
      user(4, null as unknown as string, 'No Email'),
    ],
    orders: [
      { id: '10', user_id: '1', contact_email: CANARIES.email, total: '120.50', status: 'paid', note: CANARIES.orderNote, country: 'CZ' },
      { id: '11', user_id: '1', contact_email: CANARIES.email, total: '9.99', status: 'new', note: 'ring twice', country: 'CZ' },
      { id: '12', user_id: '2', contact_email: 'jan.novak@firma.cz', total: '1500.00', status: 'shipped', note: null, country: 'SK' },
      { id: '13', user_id: '3', contact_email: 'eva.svobodova@firma.cz', total: '42.00', status: 'paid', note: 'gift', country: 'CZ' },
    ],
    countries: [
      { code: 'CZ', name: 'Czechia' },
      { code: 'SK', name: 'Slovakia' },
    ],
  },
}
