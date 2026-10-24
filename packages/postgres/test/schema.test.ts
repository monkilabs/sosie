import { describe, expect, it } from 'vitest'
import { typeByOid } from '../src/schema.js'
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

  it('types computed values by their OID', () => {
    expect(typeByOid(25, catalog.enums)).toEqual({ kind: 'string' })
    expect(typeByOid(1007, catalog.enums)).toEqual({ kind: 'array', of: { kind: 'integer', bytes: 4 } })
    expect(typeByOid(900, catalog.enums)).toEqual({ kind: 'enum', labels: ['sad', 'ok', 'happy'] })
    expect(typeByOid(1186, catalog.enums)).toEqual({ kind: 'unknown' })
  })
})
