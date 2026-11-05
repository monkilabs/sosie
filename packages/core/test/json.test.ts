import { describe, expect, it } from 'vitest'
import { exactInteger, parseJson } from '../src/json.js'

describe('JSON', () => {
  it('keeps an integer beyond 2^53 as written', () => {
    const doc = parseJson('{"id": 1234567890123456789}') as { id: unknown }
    expect(exactInteger(doc.id)).toBe('1234567890123456789')
  })

  it('skips a byte order mark before it, as some APIs send one', () => {
    expect(parseJson('﻿{"data": []}')).toEqual({ data: [] })
  })
})
