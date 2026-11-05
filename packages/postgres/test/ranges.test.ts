import { describe, expect, it } from 'vitest'
import { after, parseRanges, serializeRanges } from '../src/ranges.js'

describe('ranges', () => {
  it.each([
    '[1,10)',
    '(,5]',
    '[3,)',
    '(,)',
    'empty',
    '["2025-03-14 09:00:00+01","2025-03-15 09:00:00+01")',
    '["a \\"quoted\\" one","b, c"]',
    '["",z)',
    '{}',
    '{[1,3),[5,7)}',
    '{[2025-01-01,2025-02-01),empty}',
  ])('reads %s and writes it back as Postgres would', (text) => {
    const { multi, ranges } = parseRanges(text)
    const again = serializeRanges(multi, ranges)
    expect(parseRanges(again)).toEqual({ multi, ranges })
  })

  it('reads quoted bounds, doubled quotes and backslashes included', () => {
    expect(parseRanges('["a ""b"" \\\\c",d)').ranges).toEqual([{ lower: 'a "b" \\c', upper: 'd', open: '[', close: ')' }])
    expect(serializeRanges(false, [{ lower: 'a "b"', upper: null, open: '(', close: ')' }])).toBe('("a ""b""",)')
  })

  it.each(['', '[1,10', '1,10)', '[1;10)', '{[1,3)', '{[1,3),}', '["open,1)', 'emptyx'])('refuses %j', (text) => {
    expect(() => parseRanges(text)).toThrow()
  })

  it('orders bounds as their subtype does', () => {
    expect(after('10', '9', 'integer')).toBe(true)
    expect(after('2025-03-15 09:00:00+01', '2025-03-15 09:30:00+02', 'datetime')).toBe(true)
    expect(after('2025-01-02', '2025-01-10', 'date')).toBe(false)
    expect(after('b', 'a', 'string')).toBe(true)
  })
})
