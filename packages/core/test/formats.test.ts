import { describe, expect, it } from 'vitest'
import { formatByName } from '../src/fake/formats.js'
import { planFields, planner } from '../src/domains.js'
import { loadRules } from '../src/rules.js'
import { schema } from '../../../test/memory-source/fixtures.js'

describe('formats by name', () => {
  it.each([
    ['email', 'email'],
    ['contact_email', 'email'],
    ['first_name', 'first_name'],
    ['surname', 'last_name'],
    ['phone_number', 'phone'],
    ['address_line1', 'street'],
    ['zip', 'postal_code'],
    ['username', 'username'],
    ['website', 'url'],
    ['iban', 'iban'],
    ['status', undefined],
    ['emailed_at', undefined],
  ])('%s is %s', (name, format) => {
    expect(formatByName({ name })).toBe(format)
  })

  it('reads name as a person only in tables of people', () => {
    expect(formatByName({ name: 'name' }, { name: 'customers' })).toBe('full_name')
    expect(formatByName({ name: 'name' }, { name: 'products' })).toBeUndefined()
  })
})

describe('domains', () => {
  const plans = planFields(schema, loadRules('pass:\n  - orders.status\nformat:\n  users.account: iban\n', schema))

  it('a field that passes has none', () => {
    expect(plans.get('orders.status')!.domain).toBeNull()
  })

  it('a foreign key shares the domain of its key', () => {
    expect(plans.get('orders.user_id')!.domain).toBe('users.id')
    expect(plans.get('orders.country')!.domain).toBe('countries.code')
  })

  it('a personal format shares the format domain', () => {
    expect(plans.get('users.email')!.domain).toBe('format:email')
    expect(plans.get('orders.contact_email')!.domain).toBe('format:email')
    expect(plans.get('users.name')!.domain).toBe('format:full_name')
  })

  it('plans a field learned at runtime as it would one in the schema', () => {
    const rules = loadRules('pass:\n  - order.status\n  - country.*\n', { entities: [] }, 'sosie.yml', { learns: true })
    const plan = planner({ entities: [] }, rules)
    expect(plan({ id: 'order.status', name: 'status', type: { kind: 'string' } }).domain).toBeNull()
    expect(plan({ id: 'country.name', name: 'name', type: { kind: 'string' } }).domain).toBeNull()
    expect(plan({ id: 'user.email', name: 'email', type: { kind: 'string' } }).domain).toBe('format:email')
    expect(plan({ id: 'user.name', name: 'name', type: { kind: 'string' } }).domain).toBe('format:full_name')
    expect(plan({ id: 'order.userId', name: 'userId', type: { kind: 'integer' }, references: 'user.id' }).domain).toBe('user.id')
    expect(plan({ id: 'user.contact', name: 'contact', type: { kind: 'string' }, format: 'email' }).domain).toBe('format:email')
  })

  it('anything else fakes in its own domain, with the format sosie.yml gives', () => {
    expect(plans.get('users.account')).toMatchObject({ domain: 'users.account', format: 'iban', unique: true })
    expect(plans.get('orders.total')).toMatchObject({ domain: 'orders.total', unique: false })
    expect(plans.get('orders.country')!.type).toEqual({ kind: 'string', maxLength: 2 })
  })
})
