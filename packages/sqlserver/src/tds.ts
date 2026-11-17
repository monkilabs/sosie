import type { Readable } from 'node:stream'

/** TDS's packet types (MS-TDS 2.2.3.1.1): what a message is. */
export const PACKET = {
  BATCH: 0x01,
  RPC: 0x03,
  REPLY: 0x04,
  ATTENTION: 0x06,
  BULK: 0x07,
  FEDAUTH: 0x08,
  TRANSACTION: 0x0e,
  LOGIN7: 0x10,
  SSPI: 0x11,
  PRELOGIN: 0x12,
} as const

/** A packet's status bits: the last packet of its message, and a request that resets the session first. */
export const STATUS = { EOM: 0x01, IGNORE: 0x02, RESET: 0x08, RESET_SKIP_TRAN: 0x10 } as const

export const HEADER = 8

/** The packet size every session starts with, until LOGIN7 asks for another. */
export const INITIAL_PACKET_SIZE = 4096

export interface Message {
  type: number
  /** The first packet's status: its RESET bits, for a request. */
  status: number
  payload: Buffer
}

/** A message as packets of at most `size` bytes, the last marked end of message; `status` goes on the first. */
export function packets(type: number, payload: Buffer, size = INITIAL_PACKET_SIZE, status = 0): Buffer {
  const room = size - HEADER
  const out: Buffer[] = []
  for (let off = 0, id = 1; ; off += room, id++) {
    const part = payload.subarray(off, off + room)
    const last = off + room >= payload.length
    const head = Buffer.alloc(HEADER)
    head[0] = type
    head[1] = (last ? STATUS.EOM : 0) | (off === 0 ? status & ~STATUS.EOM : 0)
    head.writeUInt16BE(part.length + HEADER, 2)
    head[6] = id & 0xff
    out.push(head, part)
    if (last) return Buffer.concat(out)
  }
}

/** The most a client may send as one message: a batch or an RPC far larger is no read. */
export const MAX_MESSAGE = 256 * 1024 * 1024

export class MessageTooLarge extends Error {}

/**
 * Whole messages from a stream of TDS packets. An ATTENTION is told at once, to `attention`, as it may come while a
 * request is being answered; every other message waits for `next`.
 */
export class Messages {
  #buf: Buffer = Buffer.alloc(0)
  #parts: Buffer[] = []
  #size = 0
  #first: { type: number; status: number } | undefined
  readonly #ready: Message[] = []
  readonly #waiting: ((message: Message | null) => void)[] = []
  #ended = false
  #error: Error | undefined
  attention: (() => void) | undefined

  constructor(
    stream: Readable,
    private readonly max = MAX_MESSAGE,
  ) {
    stream.on('data', (chunk: Buffer) => this.#data(chunk))
    const end = () => {
      this.#ended = true
      this.#flush()
    }
    stream.on('end', end)
    stream.on('close', end)
    stream.on('error', end)
  }

  #data(chunk: Buffer): void {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk
    while (this.#buf.length >= HEADER) {
      const length = this.#buf.readUInt16BE(2)
      if (length < HEADER) {
        this.#fail(new Error('A TDS packet shorter than its header.'))
        return
      }
      if (this.#buf.length < length) break
      const type = this.#buf[0]!
      const status = this.#buf[1]!
      const part = this.#buf.subarray(HEADER, length)
      this.#buf = this.#buf.subarray(length)
      if (type === PACKET.ATTENTION && !this.#first) {
        this.attention?.()
        continue
      }
      this.#first ??= { type, status }
      this.#size += part.length
      if (this.#size > this.max) {
        this.#fail(new MessageTooLarge(`A message of more than ${this.max} bytes.`))
        return
      }
      this.#parts.push(part)
      if (status & STATUS.EOM) {
        this.#ready.push({ ...this.#first, payload: Buffer.concat(this.#parts) })
        this.#parts = []
        this.#size = 0
        this.#first = undefined
      }
    }
    this.#flush()
  }

  #fail(error: Error): void {
    this.#error = error
    this.#ended = true
    this.#buf = Buffer.alloc(0)
    this.#flush()
  }

  #flush(): void {
    while (this.#waiting.length && (this.#ready.length || this.#ended)) {
      this.#waiting.shift()!(this.#ready.shift() ?? null)
    }
  }

  /** The next message; null once the stream ended. Throws what made the stream unreadable. */
  async next(): Promise<Message | null> {
    const message = await new Promise<Message | null>((resolve) => {
      this.#waiting.push(resolve)
      this.#flush()
    })
    if (!message && this.#error) throw this.#error
    return message
  }
}

/** A cursor over a payload, as TDS writes numbers (little-endian) and text (UTF-16LE). Reading past the end throws. */
export class Cursor {
  at = 0
  constructor(readonly buf: Buffer) {}

  get left(): number {
    return this.buf.length - this.at
  }
  done(): boolean {
    return this.at >= this.buf.length
  }
  #need(n: number): void {
    if (this.at + n > this.buf.length) throw new TruncatedError()
  }
  u8(): number {
    this.#need(1)
    return this.buf[this.at++]!
  }
  u16(): number {
    this.#need(2)
    const v = this.buf.readUInt16LE(this.at)
    this.at += 2
    return v
  }
  u16be(): number {
    this.#need(2)
    const v = this.buf.readUInt16BE(this.at)
    this.at += 2
    return v
  }
  u32(): number {
    this.#need(4)
    const v = this.buf.readUInt32LE(this.at)
    this.at += 4
    return v
  }
  i32(): number {
    this.#need(4)
    const v = this.buf.readInt32LE(this.at)
    this.at += 4
    return v
  }
  u64(): bigint {
    this.#need(8)
    const v = this.buf.readBigUInt64LE(this.at)
    this.at += 8
    return v
  }
  bytes(n: number): Buffer {
    this.#need(n)
    const v = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return v
  }
  /** Text counted in characters by a byte. */
  bvarchar(): string {
    return this.bytes(this.u8() * 2).toString('utf16le')
  }
  /** Text counted in characters by two bytes. */
  usvarchar(): string {
    return this.bytes(this.u16() * 2).toString('utf16le')
  }
}

/** A payload ended before what it said it holds. */
export class TruncatedError extends Error {
  constructor() {
    super('A TDS message ended before its contents did.')
  }
}

export const u8 = (n: number) => Buffer.from([n & 0xff])
export function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
export function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
export function i32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}
export function u64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
/** Text counted in characters by a byte: at most 255 of them. */
export function bvarchar(text: string): Buffer {
  const chars = text.slice(0, 255)
  return Buffer.concat([u8(chars.length), Buffer.from(chars, 'utf16le')])
}
/** Text counted in characters by two bytes. */
export function usvarchar(text: string): Buffer {
  const chars = text.slice(0, 0xffff)
  return Buffer.concat([u16(chars.length), Buffer.from(chars, 'utf16le')])
}

/**
 * ALL_HEADERS, which every batch, RPC and transaction request opens with in TDS 7.2 and later: the transaction the
 * request runs in, and how many requests are outstanding.
 */
export function allHeaders(transaction: Buffer = Buffer.alloc(8)): Buffer {
  return Buffer.concat([u32(22), u32(18), u16(2), transaction.subarray(0, 8), u32(1)])
}

/** Where a request's ALL_HEADERS ends: its first four bytes say how long it is. */
export function headersEnd(payload: Buffer): number {
  if (payload.length < 4) throw new TruncatedError()
  const length = payload.readUInt32LE(0)
  if (length < 4 || length > payload.length) throw new TruncatedError()
  return length
}
