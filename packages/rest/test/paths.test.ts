import { describe, expect, it } from 'vitest'
import type { Operation } from '../src/openapi.js'
import { route, singular, valueByHabit, wordName } from '../src/paths.js'
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

describe('paths in links', () => {
  it('read whatever follows a collection as its member, unless it is a word the API has shown to be a name', () => {
    const known = new Set(['users', 'repos'])
    const habit = (segment: string, _: number, afterName: boolean) => valueByHabit(segment, afterName, known)
    const login = route(['users', 'quillon', 'repos'], [], entityFor, habit)
    expect(login.entity).toBe('repo')
    expect([...login.values].map(([i, f]) => [i, f.id, f.type.kind])).toEqual([[1, 'user.id', 'string']])
    // A word after a value names a collection; a value with nothing before it is the root's.
    expect([...route(['7739182046'], [], entityFor, habit).values].map(([i, f]) => [i, f.id])).toEqual([[0, 'root.id']])
    expect(route(['users', 'repos'], [], entityFor, habit).values.size).toBe(0)
  })

  it('tell query names that are words from names that are values', () => {
    for (const name of ['page', 'sort-by', 'filter[email]', 'pageSize', 'page[size]', 'q', 'per_page', 'ids[]', 'ids[0]']) expect(wordName(name)).toBe(true)
    for (const name of ['q[Quillon]', 'Vantablack', 'quill.vantablack@canary-mail.test', '7739182046', '']) expect(wordName(name)).toBe(false)
  })
})

describe('upstream headers', () => {
  it('reads one Name: value per line, from a real newline or a written one', () => {
    expect(parseHeaders('Authorization: Bearer a:b\nX-Team: core')).toEqual({ authorization: 'Bearer a:b', 'x-team': 'core' })
    expect(parseHeaders('Authorization: Bearer x\\nX-Team: core')).toEqual({ authorization: 'Bearer x', 'x-team': 'core' })
    expect(parseHeaders(undefined)).toEqual({})
  })
})
