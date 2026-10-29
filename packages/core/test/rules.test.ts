import { describe, expect, it } from 'vitest'
import { loadRules, RulesError, suggest } from '../src/rules.js'
import { schema } from '../../../test/memory-source/fixtures.js'

const problems = (text: string) => {
  try {
    loadRules(text, schema)
  } catch (error) {
    expect(error).toBeInstanceOf(RulesError)
    return (error as RulesError).problems
  }
  throw new Error('expected problems')
}

describe('sosie.yml', () => {
  it('is optional: empty means every value is faked', () => {
    const rules = loadRules('', schema)
    expect(rules.pass.size).toBe(0)
    expect(rules.format.size).toBe(0)
  })

  it('lists fields that pass, and whole entities with .*', () => {
    const rules = loadRules('pass:\n  - orders.status\n  - countries.*\nformat:\n  users.account: iban\n', schema)
    expect([...rules.pass].sort()).toEqual(['countries.code', 'countries.name', 'orders.status'])
    expect(rules.format.get('users.account')).toBe('iban')
  })

  it('names a typo and suggests the field meant', () => {
    expect(problems('pass:\n  - users.emial\n')).toEqual(['sosie.yml: users.emial is not a field. Did you mean users.email?'])
    expect(problems('pass:\n  - user.email\n')).toEqual(['sosie.yml: user is not a table. Did you mean users?'])
    expect(problems('passes:\n  - users.email\n')).toEqual(['sosie.yml: passes is not a key. Did you mean pass? Keys: pass, format.'])
    expect(problems('format:\n  users.account: ibna\n')[0]).toMatch(/^sosie\.yml: ibna is not a format\. Did you mean iban\?/)
  })

  it('reports every problem at once', () => {
    expect(problems('pass:\n  - users.emial\n  - orderz.*\nformat:\n  users.nme: email\n')).toHaveLength(3)
  })

  it('refuses a foreign key that passes while its key is faked', () => {
    expect(problems('pass:\n  - orders.user_id\n')).toEqual([
      'sosie.yml: orders.user_id passes but users.id, whose values it shares, does not. List both or neither.',
    ])
    expect(loadRules('pass:\n  - orders.user_id\n  - users.id\n', schema).pass.size).toBe(2)
  })

  it('explains a malformed file', () => {
    expect(problems('pass: orders.status\n')[0]).toMatch(/pass is a list of fields/)
    expect(problems('- a\n- b\n')[0]).toMatch(/expected the keys pass and format/)
    expect(problems('pass: [\n')[0]).toMatch(/^sosie\.yml: /)
  })

  it('for a source that learns its fields, keeps the ones not met yet, with a warning', () => {
    const rules = loadRules('pass:\n  - order.status\n  - user.*\nformat:\n  user.handle: username\n', { entities: [] }, 'sosie.yml', { learns: true })
    expect([...rules.pass]).toEqual(['order.status', 'user.*'])
    expect(rules.format.get('user.handle')).toBe('username')
    expect(rules.warnings).toHaveLength(3)
    expect(rules.warnings[0]).toBe('sosie.yml: order is not known yet: it applies once Sosie meets it.')
    expect(problems('format:\n  user.handle: usrname\n')[0]).toMatch(/usrname is not a format/)
  })

  it('refuses, even for a source that learns its fields, a rule for what names no entity or is Sosie’s own', () => {
    for (const id of ['*.*', '*.error', '$path', '$query.value', '$key']) {
      expect(() => loadRules(`pass:\n  - "${id}"\n`, { entities: [] }, 'sosie.yml', { learns: true }), id).toThrow(/names no entity/)
    }
    expect(() => loadRules('pass:\n  - users\n', { entities: [] })).toThrow(/users is not a table/)
  })

  it('suggests only near misses', () => {
    expect(suggest('emial', ['email', 'name'])).toBe('email')
    expect(suggest('zzzzzz', ['email', 'name'])).toBeUndefined()
  })
})
