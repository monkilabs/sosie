import { describe, expect, it } from 'vitest'
import { crossSite, localRequest, readCapped, why } from '../src/http.js'
import { parseJson } from '../src/json.js'
import { capLists } from '../src/mcp.js'

/** A body sent in chunks, with no content-length, as a chunked answer is. */
function chunked(chunks: string[]): Response {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks.length) return controller.close()
      controller.enqueue(new TextEncoder().encode(chunks[sent++]!))
    },
  })
  return new Response(stream)
}

describe('HTTP sources', () => {
  it('read a body within its cap, and refuse one past it as soon as it passes', async () => {
    expect(await readCapped(chunked(['{"a":', '1}']), 100)).toBe('{"a":1}')
    let pulled = 0
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++
          controller.enqueue(new Uint8Array(1024))
        },
      }),
    )
    await expect(readCapped(endless, 10 * 1024)).rejects.toThrow('The API answered with more than 10240 bytes; Sosie fakes up to that.')
    expect(pulled).toBeLessThan(20)
    const declared = new Response('x', { headers: { 'content-length': '999999' } })
    await expect(readCapped(declared, 1000)).rejects.toThrow('The API answered with 999999 bytes; Sosie fakes up to 1000.')
  })

  it('say why a request failed, with the cause fetch keeps', () => {
    expect(why(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) }))).toBe(
      'fetch failed: connect ECONNREFUSED 127.0.0.1:9',
    )
    expect(why(new Error('The API redirected too many times.'))).toBe('The API redirected too many times.')
  })

  it('answer requests for this machine only, when listening on it', () => {
    for (const host of ['localhost:7674', '127.0.0.1:7674', '[::1]:7674', 'LOCALHOST', 'localhost']) expect(localRequest(host, '127.0.0.1')).toBe(true)
    for (const host of ['attacker.example', 'attacker.example:7674', 'localhost.attacker.example', undefined]) {
      expect(localRequest(host, '127.0.0.1')).toBe(false)
    }
    expect(localRequest('dev-box.internal:7674', '0.0.0.0')).toBe(true)
    // Any 127. address is this machine's own, and as guarded as 127.0.0.1.
    expect(localRequest('rebound.attacker.test', '127.0.0.2')).toBe(false)
    expect(localRequest('127.0.0.2:7674', '127.0.0.2')).toBe(true)
  })

  it('tell a page of another site from a page of this machine, and from a client that is no browser', () => {
    expect(crossSite({ origin: 'https://attacker.example' }, '127.0.0.1')).toBe(true)
    expect(crossSite({ origin: 'null' }, '127.0.0.1')).toBe(true)
    expect(crossSite({ 'sec-fetch-site': 'cross-site' }, '127.0.0.1')).toBe(true)
    expect(crossSite({ origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' }, '127.0.0.1')).toBe(false)
    expect(crossSite({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }, '127.0.0.1')).toBe(false)
    expect(crossSite({ origin: 'http://[::1]:3000' }, '::1')).toBe(false)
    expect(crossSite({}, '127.0.0.1')).toBe(false)
    expect(crossSite({ origin: 'https://attacker.example' }, '0.0.0.0')).toBe(false)
  })

  it('cut every list of a body for an agent, nested ones too', () => {
    expect(capLists({ data: [1, 2, 3], meta: { tags: ['a', 'b'] } }, 2)).toEqual({ value: { data: [1, 2], meta: { tags: ['a', 'b'] } }, cut: true })
    expect(capLists([{ items: [1] }], 2)).toEqual({ value: [{ items: [1] }], cut: false })
    // An integer beyond 2^53, parsed as written, is written as it was.
    expect(JSON.stringify(capLists(parseJson('{"ids":[12345678901234567890,7]}'), 2).value)).toBe('{"ids":[12345678901234567890,7]}')
  })
})
