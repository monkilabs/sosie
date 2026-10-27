import { describe, expect, it } from 'vitest'
import { parseDocument, readApi } from '../src/openapi.js'

const yaml = `
openapi: 3.0.3
info: { title: Shop, version: '1' }
paths:
  /users/me:
    get:
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/User' } } } }
  /users/{id}:
    get:
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/User' } } } }
  /orders:
    get:
      responses:
        '200': { content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Order' } } } } }
    post:
      responses: { '201': { description: created } }
components:
  schemas:
    Named:
      type: object
      properties:
        name: { type: string, maxLength: 80 }
    User:
      allOf:
        - $ref: '#/components/schemas/Named'
        - type: object
          properties:
            id: { type: string, format: uuid }
            contact: { type: string, format: email }
            born: { type: string, format: date }
            seen: { type: string, format: date-time }
            score: { type: number }
            visits: { type: integer, format: int32 }
            active: { type: boolean }
            role: { type: string, enum: [admin, viewer] }
            tags: { type: array, items: { type: string } }
            address:
              type: object
              properties:
                city: { type: string }
            extra: { type: object, additionalProperties: true }
            orders: { type: array, items: { $ref: '#/components/schemas/Order' } }
    Order:
      type: object
      properties:
        id: { type: integer }
        user_id: { type: string, format: uuid }
`

describe('an OpenAPI document', () => {
  const api = readApi(parseDocument(yaml))
  const user = api.schema.entities.find((e) => e.id === 'User')!
  const field = (name: string) => user.fields.find((f) => f.id === `User.${name}`)

  it('reads YAML and JSON, and refuses anything else', () => {
    expect(api.version).toBe('OpenAPI 3.0')
    expect(readApi(parseDocument(JSON.stringify({ swagger: '2.0', paths: {}, definitions: {} }))).version).toBe('Swagger 2.0')
    expect(() => parseDocument('<html>docs</html>')).toThrow('Not an OpenAPI document')
  })

  it('maps each object schema to an entity, allOf merged and nested objects dotted', () => {
    expect(api.schema.entities.map((e) => e.id)).toEqual(['Named', 'User', 'Order'])
    expect(user.fields.map((f) => f.id)).toEqual([
      'User.name',
      'User.id',
      'User.contact',
      'User.born',
      'User.seen',
      'User.score',
      'User.visits',
      'User.active',
      'User.role',
      'User.tags',
      'User.address.city',
      'User.extra',
    ])
  })

  it('types each field by its type and format, and keeps the format it names', () => {
    expect(field('name')!.type).toEqual({ kind: 'string', maxLength: 80 })
    expect(field('id')).toMatchObject({ type: { kind: 'uuid' }, key: 'primary' })
    expect(field('contact')).toMatchObject({ type: { kind: 'string' }, format: 'email' })
    expect(field('born')!.type).toEqual({ kind: 'date' })
    expect(field('seen')!.type).toEqual({ kind: 'datetime' })
    expect(field('score')!.type).toEqual({ kind: 'decimal' })
    expect(field('visits')!.type).toEqual({ kind: 'integer', bytes: 4 })
    expect(field('active')!.type).toEqual({ kind: 'boolean' })
    expect(field('role')!.type).toEqual({ kind: 'enum', labels: ['admin', 'viewer'] })
    expect(field('tags')!.type).toEqual({ kind: 'array', of: { kind: 'string' } })
    expect(field('extra')!.type).toEqual({ kind: 'json' })
  })

  it('links a field named for another entity to its id', () => {
    expect(api.schema.entities.find((e) => e.id === 'Order')!.fields.find((f) => f.name === 'user_id')!.references).toBe('User.id')
  })

  it('reads the GET operations, the most specific first', () => {
    expect(api.operations.map((o) => [o.template, o.entity])).toEqual([
      ['/users/me', 'User'],
      ['/users/{id}', 'User'],
      ['/orders', 'Order'],
    ])
  })
})
