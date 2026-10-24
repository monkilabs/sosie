import { describe, expect, it } from 'vitest'
import { parseArray, serializeArray } from '../src/arrays.js'

describe('array text', () => {
  it.each([
    ['{}', []],
    ['{a,b}', ['a', 'b']],
    ['{"a b","c,d",NULL,"NULL",""}', ['a b', 'c,d', null, 'NULL', '']],
    ['{"quote \\" and \\\\"}', ['quote " and \\']],
    ['{{1,2},{3,4}}', [['1', '2'], ['3', '4']]],
  ])('parses %s and prints it back', (text, items) => {
    expect(parseArray(text).items).toEqual(items)
    expect(serializeArray(parseArray(text).items)).toBe(text)
  })

  it('keeps bounds', () => {
    expect(parseArray('[0:1]={x,y}')).toEqual({ bounds: '[0:1]=', items: ['x', 'y'] })
    expect(serializeArray(['x', 'y'], '[0:1]=')).toBe('[0:1]={x,y}')
  })
})
