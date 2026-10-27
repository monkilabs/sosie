import { describe, expect, it } from 'vitest'
import type { Operation } from '../src/openapi.js'
import { route, singular } from '../src/paths.js'
import { upstreamHeaders as parseHeaders } from '@sosie/core'

const entityFor = (word: string) => singular(word.toLowerCase())
const numbers = (s: string) => /^\d+$/.test(s)

describe('paths', () => {
  it.each([
    ['users', 'user'],
    ['categories', 'category'],
    ['addresses', 'address'],
    ['boxes', 'box'],
    ['status', 'status'],
    ['analysis', 'analysis'],
    ['address', 'address'],
    ['news', 'new'],
  ])('reads %s as %s', (plural, one) => {
    expect(singular(plural)).toBe(one)
  })

  it('reads a path as a collection and its members, without a document', () => {
    const r = route(['users', '87', 'orders', '12'], [], entityFor, numbers)
    expect(r.entity).toBe('order')
    expect([...r.values].map(([i, f]) => [i, f.id, f.type.kind])).toEqual([
      [1, 'user.id', 'integer'],
      [3, 'order.id', 'integer'],
    ])
  })

  it('reads a path by its OpenAPI template, the parameter naming whose id it is', () => {
    const operations: Operation[] = [
      { template: '/users/me', segments: ['users', 'me'], entity: 'User' },
      { template: '/users/{userId}/orders', segments: ['users', '{userId}', 'orders'], entity: 'Order' },
    ]
    const byWord = (w: string) => ({ user: 'User', order: 'Order' })[singular(w.toLowerCase())] ?? w
    expect(route(['users', 'me'], operations, byWord, numbers).values.size).toBe(0)
    const nested = route(['users', 'usr_ab12', 'orders'], operations, byWord, numbers)
    expect(nested.entity).toBe('Order')
    expect(nested.values.get(1)).toMatchObject({ id: 'User.id', type: { kind: 'string' } })
  })
})

describe('upstream headers', () => {
  it('reads one Name: value per line, from a real newline or a written one', () => {
    expect(parseHeaders('Authorization: Bearer a:b\nX-Team: core')).toEqual({ authorization: 'Bearer a:b', 'x-team': 'core' })
    expect(parseHeaders('Authorization: Bearer x\\nX-Team: core')).toEqual({ authorization: 'Bearer x', 'x-team': 'core' })
    expect(parseHeaders(undefined)).toEqual({})
  })
})
