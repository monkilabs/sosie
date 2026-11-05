import type { Socket } from 'node:net'
import { BSON, type Document } from 'bson'

/**
 * The server side of MongoDB's wire protocol, as much as Sosie speaks: OP_MSG, which every driver since MongoDB 3.6
 * sends, and OP_QUERY for the first hello of a handshake, answered with OP_REPLY. No compression is offered, so none
 * comes; OP_COMPRESSED gets an error.
 */

export const OP = { REPLY: 1, QUERY: 2004, COMPRESSED: 2012, MSG: 2013 } as const

const CHECKSUM_PRESENT = 1
const MORE_TO_COME = 1 << 1

/** The largest message Sosie reads or writes: MongoDB's own maxMessageSizeBytes. */
export const MAX_MESSAGE = 48_000_000

/** BSON as Sosie reads it: every value in its own type, so what it does not change goes back byte for byte. */
export const READ = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const

export interface Message {
  requestId: number
  opCode: number
  /** OP_MSG: the command, its document sequences (kind 1) set on it as arrays. OP_QUERY: the query. */
  body: Document
  /** OP_MSG's moreToCome: the client waits for no answer. */
  moreToCome: boolean
  /** OP_QUERY's namespace: admin.$cmd for a command. */
  namespace?: string
}

/** How long a message may stay half sent: past it, the connection is closed, and what it held let go. */
const HALF_SENT = 60_000

/** Reads whole messages from a socket: the chunks each comes in are joined once, when all have come. */
export class MessageReader {
  #chunks: Buffer[] = []
  #size = 0
  #waiting: ((ok: boolean) => void) | undefined
  #ended = false

  constructor(socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.#chunks.push(chunk)
      this.#size += chunk.length
      this.#wake(true)
    })
    socket.on('close', () => {
      this.#ended = true
      this.#wake(false)
    })
    socket.on('error', () => {})
  }

  #wake(ok: boolean): void {
    const waiting = this.#waiting
    this.#waiting = undefined
    waiting?.(ok)
  }

  /** More bytes; false once the client is gone. Throws when a message stays half sent too long. */
  async #more(): Promise<boolean> {
    const half = this.#size > 0
    let timer: NodeJS.Timeout | undefined
    const stalled = new Promise<never>((_, reject) => {
      if (half) timer = setTimeout(() => reject(new ProtocolError('A message half sent for a minute.')), HALF_SENT)
    })
    try {
      return await Promise.race([new Promise<boolean>((resolve) => (this.#waiting = resolve)), stalled])
    } finally {
      clearTimeout(timer)
      this.#waiting = undefined
    }
  }

  /** The chunks as one buffer. */
  #joined(): Buffer {
    if (this.#chunks.length > 1) this.#chunks = [Buffer.concat(this.#chunks, this.#size)]
    return this.#chunks[0] ?? Buffer.alloc(0)
  }

  /** The next message; undefined once the client is gone. Throws on one that does not read as a message. */
  async next(): Promise<Message | undefined> {
    while (this.#size < 4) {
      if (this.#ended || !(await this.#more())) return undefined
    }
    const length = this.#joined().readInt32LE(0)
    if (length < 16 || length > MAX_MESSAGE) throw new ProtocolError(`A message of ${length} bytes.`)
    while (this.#size < length) {
      if (this.#ended || !(await this.#more())) return undefined
    }
    const all = this.#joined()
    const frame = all.subarray(0, length)
    const rest = all.subarray(length)
    this.#chunks = rest.length ? [rest] : []
    this.#size = rest.length
    return readMessage(frame)
  }
}

export class ProtocolError extends Error {}

export function readMessage(frame: Buffer): Message {
  const requestId = frame.readInt32LE(4)
  const opCode = frame.readInt32LE(12)
  if (opCode === OP.MSG) {
    const flags = frame.readUInt32LE(16)
    const end = flags & CHECKSUM_PRESENT ? frame.length - 4 : frame.length
    let at = 20
    let body: Document | undefined
    const sequences: [string, Document[]][] = []
    while (at < end) {
      const kind = frame[at++]
      if (kind === 0) {
        const size = frame.readInt32LE(at)
        body = BSON.deserialize(frame.subarray(at, at + size), READ)
        at += size
      } else if (kind === 1) {
        const size = frame.readInt32LE(at)
        const stop = at + size
        const nul = frame.indexOf(0, at + 4)
        const id = frame.subarray(at + 4, nul).toString('utf8')
        const docs: Document[] = []
        for (let p = nul + 1; p < stop; ) {
          const docSize = frame.readInt32LE(p)
          docs.push(BSON.deserialize(frame.subarray(p, p + docSize), READ))
          p += docSize
        }
        sequences.push([id, docs])
        at = stop
      } else throw new ProtocolError(`A section of kind ${kind}.`)
    }
    if (!body) throw new ProtocolError('A message with no body.')
    for (const [id, docs] of sequences) body[id] = docs
    return { requestId, opCode, body, moreToCome: (flags & MORE_TO_COME) !== 0 }
  }
  if (opCode === OP.QUERY) {
    let at = 20
    const nul = frame.indexOf(0, at)
    const namespace = frame.subarray(at, nul).toString('utf8')
    at = nul + 1 + 8
    const size = frame.readInt32LE(at)
    const body = BSON.deserialize(frame.subarray(at, at + size), READ)
    return { requestId, opCode, body, moreToCome: false, namespace }
  }
  return { requestId, opCode, body: {}, moreToCome: false }
}

let nextId = 1

function header(length: number, responseTo: number, opCode: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeInt32LE(length, 0)
  b.writeInt32LE(nextId++ & 0x7fffffff, 4)
  b.writeInt32LE(responseTo, 8)
  b.writeInt32LE(opCode, 12)
  return b
}

/** An OP_MSG answer: no flags, one body. */
export function msgReply(responseTo: number, doc: Document): Buffer {
  const body = BSON.serialize(doc)
  const prefix = Buffer.alloc(5)
  prefix.writeUInt32LE(0, 0)
  prefix[4] = 0
  return Buffer.concat([header(16 + 5 + body.length, responseTo, OP.MSG), prefix, body])
}

/** An OP_REPLY answer to OP_QUERY: no cursor, one document. */
export function opReply(responseTo: number, doc: Document): Buffer {
  const body = BSON.serialize(doc)
  const fields = Buffer.alloc(20)
  fields.writeInt32LE(8, 0) // AwaitCapable, as servers set it.
  fields.writeBigInt64LE(0n, 4)
  fields.writeInt32LE(0, 12)
  fields.writeInt32LE(1, 16)
  return Buffer.concat([header(16 + 20 + body.length, responseTo, OP.REPLY), fields, body])
}
