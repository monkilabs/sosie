import { describe, expect, it } from 'vitest'
import { loopback } from '../src/listen.js'

describe('the listening address', () => {
  it('tells this machine from the network', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', 'localhost']) expect(loopback(host)).toBe(true)
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'sosie.internal']) expect(loopback(host)).toBe(false)
  })
})
