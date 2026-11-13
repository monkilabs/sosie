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

  it('reads a schema that refers to itself, as a nullable reference does', () => {
    const api = readApi({
      openapi: '3.0.3',
      paths: {},
      components: {
        schemas: {
          Employee: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              email: { type: 'string' },
              manager: { allOf: [{ $ref: '#/components/schemas/Employee' }], nullable: true },
              reports: { type: 'array', items: { allOf: [{ $ref: '#/components/schemas/Employee' }] } },
            },
          },
        },
      },
    })
    expect(api.schema.entities[0]!.fields.map((f) => f.name)).toEqual(['id', 'email'])
  })

  it('reads an array of itself without end, as JSON', () => {
    const api = readApi({
      openapi: '3.1.0',
      paths: {},
      components: {
        schemas: {
          Grid: { type: 'array', items: { $ref: '#/components/schemas/Grid' } },
          Board: {
            type: 'object',
            properties: { id: { type: 'integer' }, cells: { type: 'array', items: { type: 'array', items: { $ref: '#/components/schemas/Grid' } } } },
          },
        },
      },
    })
    const cells = api.schema.entities.find((e) => e.name === 'Board')!.fields.find((f) => f.name === 'cells')!
    expect(JSON.stringify(cells.type)).toMatch(/"kind":"json"/)
  })

  it('names an entity by the collection the document answers it under, where no schema is named for the word', () => {
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
    const ok = (schema: object) => ({ get: { responses: { '200': { content: { 'application/json': { schema } } } } } })
    const record = (more: object = {}) => ({ type: 'object', properties: { id: { type: 'integer' }, ...more } })
    const api = readApi({
      openapi: '3.0.1',
      paths: {
        // The plainer path says what a word names: /admin/users/{userId} answers another kind of user.
        '/api/admin/users/{userId}': ok(ref('AdminUserResp')),
        '/api/users/{userId}': ok(ref('UserResp')),
        '/api/users/{userId}/orders': ok({ type: 'array', items: ref('OrderResp') }),
        // No id follows me, and search is no collection's name.
        '/api/users/me': ok(ref('MeResp')),
        '/api/search': ok({ type: 'array', items: ref('UserResp') }),
        // A schema named for the word keeps it.
        '/api/countries/{code}': ok(ref('CountryResp')),
        // A record without an id is not what a path's id names.
        '/api/settings/{key}': ok(ref('SettingResp')),
      },
      components: {
        schemas: {
          UserResp: record({ email: { type: 'string' } }),
          AdminUserResp: record(),
          MeResp: record(),
          OrderResp: record({ userId: { type: 'integer' } }),
          Country: record(),
          CountryResp: record(),
          SettingResp: { type: 'object', properties: { value: { type: 'string' } } },
        },
      },
    })
    expect(api.words.get('user')).toBe('UserResp')
    expect(api.words.get('order')).toBe('OrderResp')
    expect(api.words.get('country')).toBe('Country')
    expect(api.words.get('userresp')).toBe('UserResp')
    for (const word of ['me', 'search', 'setting']) expect(api.words.has(word)).toBe(false)
    // So a reference by name shares the id the answers show.
    const order = api.schema.entities.find((e) => e.id === 'OrderResp')!
    expect(order.fields.find((f) => f.name === 'userId')).toMatchObject({ references: 'UserResp.id', guessed: true })
  })

  it('reads an answer’s schema under a JSON type or a range that holds JSON, application/json first', () => {
    const ref = (name: string) => ({ schema: { $ref: `#/components/schemas/${name}` } })
    const ok = (content: object) => ({ get: { responses: { '200': { description: 'OK', content } } } })
    const api = readApi({
      openapi: '3.0.1',
      paths: {
        // Springdoc's, for a controller that does not say what it produces.
        '/springdoc': ok({ '*/*': ref('A') }),
        '/charset': ok({ 'application/json;charset=UTF-8': ref('A') }),
        '/range': ok({ 'application/*': ref('A') }),
        '/hal': ok({ 'application/hal+json': ref('A') }),
        '/text': ok({ 'text/json': ref('A') }),
        // What Sosie asks for (application/json) before a range, and a range before another JSON type.
        '/json-first': ok({ 'application/hal+json': ref('C'), '*/*': ref('B'), 'Application/JSON': ref('A') }),
        '/range-first': ok({ 'application/hal+json': ref('C'), '*/*': ref('A') }),
        // A type with no schema says nothing; one that is not JSON, nothing Sosie passes on.
        '/schemaless': ok({ 'application/json': {}, '*/*': ref('A') }),
        '/xml': ok({ 'application/xml': ref('A'), 'text/plain': ref('A') }),
      },
      components: { schemas: Object.fromEntries(['A', 'B', 'C'].map((name) => [name, { type: 'object', properties: { id: { type: 'integer' } } }])) },
    })
    expect(Object.fromEntries(api.operations.map((o) => [o.template, o.entity]))).toEqual({
      '/springdoc': 'A',
      '/charset': 'A',
      '/range': 'A',
      '/hal': 'A',
      '/text': 'A',
      '/json-first': 'A',
      '/range-first': 'A',
      '/schemaless': 'A',
      '/xml': undefined,
    })
  })

  it('reads the GET operations, the most specific first', () => {
    expect(api.operations.map((o) => [o.template, o.entity])).toEqual([
      ['/users/me', 'User'],
      ['/users/{id}', 'User'],
      ['/orders', 'Order'],
    ])
  })
})
