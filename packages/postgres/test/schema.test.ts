import { describe, expect, it } from 'vitest'
import { buildCatalog, typeByOid } from '../src/schema.js'
import { catalog } from './catalog.js'

describe('reading the catalog', () => {
  const field = (id: string) => catalog.schema.entities.flatMap((e) => e.fields).find((f) => f.id === id)

  it('maps tables and views to entities; partitions to their parent', () => {
    expect(catalog.schema.entities.map((e) => e.id)).toEqual(['users', 'orders', 'active_users', 'billing.invoices'])
    expect(catalog.tables).toBe(3)
    expect(catalog.views).toBe(1)
    expect(catalog.columns.get('102:3')).toBe(field('orders.user_id'))
  })

  it('maps types', () => {
    expect(field('users.id')!.type).toEqual({ kind: 'integer', bytes: 4 })
    expect(field('users.email')!.type).toEqual({ kind: 'string', maxLength: 120 })
    expect(field('users.status')!.type).toEqual({ kind: 'enum', labels: ['sad', 'ok', 'happy'] })
    expect(field('users.tags')!.type).toEqual({ kind: 'array', of: { kind: 'string' } })
    expect(field('users.code')!.type).toEqual({ kind: 'string' })
    expect(field('billing.invoices.amount')!.type).toEqual({ kind: 'decimal' })
  })

  it('reads keys and references, and a view column’s source', () => {
    expect(field('users.id')!.key).toBe('primary')
    expect(field('users.email')!.key).toBe('unique')
    expect(field('orders.user_id')!.references).toBe('users.id')
    expect(field('billing.invoices.order_id')!.references).toBe('orders.id')
    expect(field('active_users.email')!.references).toBe('users.email')
  })

  it('links a view column to the column it selects unchanged, and nothing it computes', () => {
    const col = (attrelid: number, attnum: number, attname: string, typname: string) => ({
      attrelid, attnum, attname, atttypmod: -1, typname, typtype: 'b', typcategory: 'S',
      element: null, element_type: null, basetype: null, enumtypid: null,
    })
    const views: [string, string[]][] = [
      [' SELECT u.id, upper(u.email) AS email FROM users u;', ['users.id', undefined as never]],
      [" SELECT u.id, (c.name || ' / '::text) || u.email AS email FROM users u JOIN countries c ON c.code = u.id;", ['users.id', undefined as never]],
      [' SELECT users.id::text AS id, users.email FROM users;', [undefined as never, 'users.email']],
      [' SELECT o.id, u.email FROM orders o JOIN users u ON u.id = o.id;', ['orders.id', 'users.email']],
      [' SELECT s.id, email FROM (SELECT users.id, users.email FROM users) s;', [undefined as never, undefined as never]],
      [' SELECT users.id, users.email FROM users UNION SELECT orders.id, orders.email FROM orders;', [undefined as never, undefined as never]],
    ]
    views.forEach(([definition, expected], i) => {
      const view = 10 + i
      const built = buildCatalog({
        relations: [
          { oid: 1, nspname: 'public', relname: 'users', relkind: 'r', parent: null },
          { oid: 2, nspname: 'public', relname: 'orders', relkind: 'r', parent: null },
          { oid: 3, nspname: 'public', relname: 'countries', relkind: 'r', parent: null },
          { oid: view, nspname: 'public', relname: 'v', relkind: 'v', parent: null },
        ],
        columns: [
          col(1, 1, 'id', 'int4'), col(1, 2, 'email', 'text'),
          col(2, 1, 'id', 'int4'), col(2, 2, 'email', 'text'),
          col(3, 1, 'code', 'int4'), col(3, 2, 'name', 'text'),
          col(view, 1, 'id', i === 2 ? 'text' : 'int4'), col(view, 2, 'email', 'text'),
        ],
        constraints: [],
        enums: new Map(),
        views: [{ view, definition }],
        functions: [],
        operators: [],
        types: [],
        setReturning: [],
        writable: 0,
        admin: false,
      })
      expect([built.columns.get(`${view}:1`)!.references, built.columns.get(`${view}:2`)!.references], definition).toEqual(expected)
    })
  })

  it('types computed values by their OID', () => {
    expect(typeByOid(25, catalog.enums)).toEqual({ kind: 'string' })
    expect(typeByOid(1007, catalog.enums)).toEqual({ kind: 'array', of: { kind: 'integer', bytes: 4 } })
    expect(typeByOid(900, catalog.enums)).toEqual({ kind: 'enum', labels: ['sad', 'ok', 'happy'] })
    expect(typeByOid(1186, catalog.enums)).toEqual({ kind: 'unknown' })
  })
})
