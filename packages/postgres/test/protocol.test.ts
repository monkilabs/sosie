import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { backend, Reader } from '../src/protocol.js'

function startup(params: Record<string, string>): Buffer {
  const body = Buffer.concat([
    Buffer.from([0, 3, 0, 0]),
    ...Object.entries(params).map(([k, v]) => Buffer.from(`${k}\0${v}\0`)),
    Buffer.from([0]),
  ])
  const length = Buffer.alloc(4)
  length.writeInt32BE(body.length + 4)
  return Buffer.concat([length, body])
}

function typed(code: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(code)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

describe('reading frontend messages', () => {
  it('reads start-up, SSL requests and queries, however the bytes arrive', async () => {
    const socket = new EventEmitter()
    const reader = new Reader(socket as unknown as Socket)
    const ssl = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])
    const bytes = Buffer.concat([ssl, startup({ user: 'kim', database: 'app' }), typed('Q', Buffer.from('SELECT 1\0')), typed('X', Buffer.alloc(0))])
    for (const byte of bytes) socket.emit('data', Buffer.from([byte]))
    expect(await reader.next()).toEqual({ type: 'ssl' })
    expect(await reader.next()).toEqual({ type: 'startup', minor: 0, params: { user: 'kim', database: 'app' } })
    expect(await reader.next()).toEqual({ type: 'query', text: 'SELECT 1' })
    expect(await reader.next()).toEqual({ type: 'terminate' })
    socket.emit('close')
    expect(await reader.next()).toBeNull()
  })

  it('reads Bind with text and binary parameters', async () => {
    const socket = new EventEmitter()
    const reader = new Reader(socket as unknown as Socket)
    socket.emit('data', startup({ user: 'kim' }))
    await reader.next()
    const body = Buffer.concat([
      Buffer.from('p\0s\0'),
      Buffer.from([0, 2, 0, 0, 0, 1]),
      Buffer.from([0, 3]),
      Buffer.from([0, 0, 0, 2]),
      Buffer.from('42'),
      Buffer.from([255, 255, 255, 255]),
      Buffer.from([0, 0, 0, 1, 7]),
      Buffer.from([0, 1, 0, 0]),
    ])
    socket.emit('data', typed('B', body))
    expect(await reader.next()).toEqual({
      type: 'bind',
      portal: 'p',
      statement: 's',
      formats: [0, 1],
      params: [Buffer.from('42'), null, Buffer.from([7])],
      results: [0],
    })
  })
})

describe('malformed messages', () => {
  it.each([
    ['a start-up packet with no code', Buffer.from([0, 0, 0, 4])],
    ['a short cancel request', Buffer.from([0, 0, 0, 8, 4, 210, 22, 46])],
  ])('end the connection on %s, never the process', async (_, bytes) => {
    const socket = new EventEmitter()
    const reader = new Reader(socket as unknown as Socket)
    socket.emit('data', bytes)
    expect(await reader.next()).toBeNull()
  })

  it('end the connection on a truncated Bind or an unterminated Parse', async () => {
    for (const message of [typed('B', Buffer.from('p\0s\0\0\x02')), typed('P', Buffer.from('name-without-end'))]) {
      const socket = new EventEmitter()
      const reader = new Reader(socket as unknown as Socket)
      socket.emit('data', startup({ user: 'kim' }))
      await reader.next()
      socket.emit('data', message)
      expect(await reader.next()).toBeNull()
    }
  })
})

describe('writing backend messages', () => {
  it('frames each message with its code and length', () => {
    expect(backend.readyForQuery('I')).toEqual(Buffer.from([90, 0, 0, 0, 5, 73]))
    expect(backend.dataRow(['a', null])).toEqual(Buffer.from([68, 0, 0, 0, 15, 0, 2, 0, 0, 0, 1, 97, 255, 255, 255, 255]))
    const error = backend.error({ severity: 'ERROR', code: '25006', message: 'no' })
    expect(error.subarray(5).toString()).toBe('SERROR\0VERROR\0C25006\0Mno\0\0')
  })
})
