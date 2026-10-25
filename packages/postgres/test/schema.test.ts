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

  it('shares a view column with its source only when their types agree', () => {
    const odd = buildCatalog({
      relations: [
        { oid: 1, nspname: 'public', relname: 'users', relkind: 'r', parent: null },
        { oid: 2, nspname: 'public', relname: 'odd', relkind: 'v', parent: null },
      ],
      columns: [
        { attrelid: 1, attnum: 1, attname: 'status', atttypmod: -1, typname: 'text', typtype: 'b', typcategory: 'S', element: null, element_type: null, basetype: null, enumtypid: null },
        { attrelid: 2, attnum: 1, attname: 'status', atttypmod: -1, typname: 'int4', typtype: 'b', typcategory: 'N', element: null, element_type: null, basetype: null, enumtypid: null },
      ],
      constraints: [],
      enums: new Map(),
      views: [{ view: 2, relation: 1, attnum: 1 }],
      functions: [],
      operators: [],
      types: [],
      writable: 0,
      admin: false,
    })
    expect(odd.columns.get('2:1')!.references).toBeUndefined()
  })

  it('types computed values by their OID', () => {
    expect(typeByOid(25, catalog.enums)).toEqual({ kind: 'string' })
    expect(typeByOid(1007, catalog.enums)).toEqual({ kind: 'array', of: { kind: 'integer', bytes: 4 } })
    expect(typeByOid(900, catalog.enums)).toEqual({ kind: 'enum', labels: ['sad', 'ok', 'happy'] })
    expect(typeByOid(1186, catalog.enums)).toEqual({ kind: 'unknown' })
  })
})
