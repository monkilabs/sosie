import { describe, expect, it } from 'vitest'
import { buildSchema, parse, print } from 'graphql'
import type { Field, RequestScope } from '@sosie/core'
import { readSchema } from '../src/schema.js'
import { rewrite } from '../src/rewrite.js'

const schema = buildSchema(`
  scalar DateTime
  scalar EmailAddress
  scalar JSON
  enum Mood { sad happy }
  interface Node { id: ID! }
  type User implements Node { id: ID! email: EmailAddress born: DateTime visits: Int score: Float vip: Boolean mood: Mood tags: [String!] meta: JSON friend: User }
  type Post implements Node { id: ID! authorId: ID! title: String }
  input PostFilter { authorId: ID title: String }
  type Query { user(id: ID!): User users(email: String, ids: [ID!]): [User!]! posts(filter: PostFilter, first: Int): [Post!]! }
  type Mutation { touch: Boolean }
`)

describe('a GraphQL schema', () => {
  const neutral = readSchema(schema)
  const user = neutral.entities.find((e) => e.id === 'User')!
  const field = (name: string) => user.fields.find((f) => f.name === name)!

  it('makes entities of object and interface types, not of the root types', () => {
    expect(neutral.entities.map((e) => e.id).sort()).toEqual(['Node', 'Post', 'User'])
  })

  it('types fields by their scalars, custom ones by name, and skips fields that hold objects', () => {
    expect(field('id')).toMatchObject({ type: { kind: 'string' }, key: 'primary' })
    expect(field('email')).toMatchObject({ type: { kind: 'string' }, format: 'email' })
    expect(field('born').type).toEqual({ kind: 'datetime' })
    expect(field('visits').type).toEqual({ kind: 'integer', bytes: 4 })
    expect(field('score').type).toEqual({ kind: 'decimal' })
    expect(field('vip').type).toEqual({ kind: 'boolean' })
    expect(field('mood').type).toEqual({ kind: 'enum', labels: ['sad', 'happy'] })
    expect(field('tags').type).toEqual({ kind: 'array', of: { kind: 'string' } })
    expect(field('meta').type).toEqual({ kind: 'json' })
    expect(user.fields.find((f) => f.name === 'friend')).toBeUndefined()
  })

  it('links a field named for another type to its id', () => {
    expect(neutral.entities.find((e) => e.id === 'Post')!.fields.find((f) => f.name === 'authorId')!.references).toBeUndefined()
    const linked = readSchema(buildSchema('type User { id: ID! } type Post { id: ID! userId: ID! } type Query { posts: [Post] }'))
    expect(linked.entities.find((e) => e.id === 'Post')!.fields.find((f) => f.name === 'userId')!.references).toBe('User.id')
  })
})

describe('rewriting a request', () => {
  const neutral = readSchema(schema)
  const fields = new Map<string, Field>(neutral.entities.flatMap((e) => e.fields.map((f) => [f.id, f] as const)))
  const names = { fields, entityFor: (w: string) => ({ user: 'User', post: 'Post' })[w] }
  /** A scope that knows fakes by the field they are compared with. */
  const seen: [string, string | undefined][] = []
  const scope: RequestScope = {
    lookup: (fake, near) => {
      seen.push([fake, near?.id])
      return ({ 'User.id:u-87': 'u-1', 'User.email:kim@example.net': 'real@corp.test', 'Post.title:Fake title': 'Real title' } as Record<string, string>)[`${near?.id}:${fake}`]
    },
    scrub: (t) => t,
  }

  it('looks arguments up in the field they name, and leaves the rest', () => {
    seen.length = 0
    const out = rewrite(schema, parse('{ user(id: "u-87") { id } users(email: "kim@example.net") { id } posts(first: 10) { id } }'), {}, scope, names)
    expect(out.changed).toBe(true)
    expect(print(out.document)).toContain('user(id: "u-1")')
    expect(print(out.document)).toContain('users(email: "real@corp.test")')
    expect(print(out.document)).toContain('posts(first: 10)')
    expect(seen.filter(([fake]) => fake === '10')).toEqual([])
  })

  it('looks variables up where they are used, inside lists and input objects too', () => {
    const out = rewrite(
      schema,
      parse('query ($id: ID!, $ids: [ID!], $f: PostFilter) { user(id: $id) { id } users(ids: $ids) { id } posts(filter: $f) { id } }'),
      { id: 'u-87', ids: ['u-87', 'other'], f: { title: 'Fake title' } },
      scope,
      names,
    )
    expect(out.variables).toEqual({ id: 'u-1', ids: ['u-87', 'other'], f: { title: 'Real title' } })
  })
})
