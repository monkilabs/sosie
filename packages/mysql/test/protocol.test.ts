import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { PacketReader } from '../src/protocol.js'

const packet = (seq: number, payload: Buffer) => {
  const header = Buffer.alloc(4)
  header.writeUIntLE(payload.length, 0, 3)
  header[3] = seq
  return Buffer.concat([header, payload])
}

describe('reading packets', () => {
  it('reads a packet that comes in many chunks, and two that come in one', async () => {
    const socket = new EventEmitter()
    const reader = new PacketReader(socket as unknown as Socket)
    const big = packet(0, Buffer.concat([Buffer.from([3]), Buffer.alloc(1_000_000, 0x61)]))
    const read = reader.next()
    for (let at = 0; at < big.length; at += 4096) socket.emit('data', big.subarray(at, at + 4096))
    expect((await read)!.payload).toHaveLength(1_000_001)
    socket.emit('data', Buffer.concat([packet(1, Buffer.from('a')), packet(2, Buffer.from('b'))]))
    expect(await reader.next()).toEqual({ payload: Buffer.from('a'), seq: 1 })
    expect(await reader.next()).toEqual({ payload: Buffer.from('b'), seq: 2 })
    socket.emit('close')
    expect(await reader.next()).toBeUndefined()
  })
})
