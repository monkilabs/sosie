import type { Socket } from 'node:net'

/**
 * The server side of MySQL's client/server protocol, as much as Sosie speaks: packets of up to 16 MB with a
 * sequence id, the version 10 handshake, the text protocol's results, and prepared statements (binary.ts). Every
 * client this serves negotiates protocol 4.1 and pluggable authentication, as every MySQL client since 5.7 does.
 */

/** Capability flags, as the protocol numbers them. */
export const CLIENT = {
  LONG_PASSWORD: 1,
  FOUND_ROWS: 2,
  LONG_FLAG: 4,
  CONNECT_WITH_DB: 8,
  PROTOCOL_41: 0x200,
  SSL: 0x800,
  TRANSACTIONS: 0x2000,
  SECURE_CONNECTION: 0x8000,
  MULTI_STATEMENTS: 0x10000,
  MULTI_RESULTS: 0x20000,
  PS_MULTI_RESULTS: 0x40000,
  PLUGIN_AUTH: 0x80000,
  CONNECT_ATTRS: 0x100000,
  PLUGIN_AUTH_LENENC_CLIENT_DATA: 0x200000,
  DEPRECATE_EOF: 0x1000000,
  QUERY_ATTRIBUTES: 0x8000000,
} as const

/** What Sosie offers: no TLS, no compression, no query attributes, and the classic EOF packets. */
export const SERVER_CAPABILITIES =
  CLIENT.LONG_PASSWORD |
  CLIENT.FOUND_ROWS |
  CLIENT.LONG_FLAG |
  CLIENT.CONNECT_WITH_DB |
  CLIENT.PROTOCOL_41 |
  CLIENT.TRANSACTIONS |
  CLIENT.SECURE_CONNECTION |
  CLIENT.MULTI_STATEMENTS |
  CLIENT.MULTI_RESULTS |
  CLIENT.PS_MULTI_RESULTS |
  CLIENT.PLUGIN_AUTH |
  CLIENT.CONNECT_ATTRS |
  CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA

export const STATUS = { IN_TRANS: 1, AUTOCOMMIT: 2, MORE_RESULTS: 8, IN_TRANS_READONLY: 0x2000 } as const

/** utf8mb4_0900_ai_ci: what Sosie speaks, whatever the client asks. */
export const UTF8MB4 = 255

export const COMMAND = {
  QUIT: 0x01,
  INIT_DB: 0x02,
  QUERY: 0x03,
  FIELD_LIST: 0x04,
  STATISTICS: 0x09,
  PING: 0x0e,
  CHANGE_USER: 0x11,
  STMT_PREPARE: 0x16,
  STMT_EXECUTE: 0x17,
  STMT_SEND_LONG_DATA: 0x18,
  STMT_CLOSE: 0x19,
  STMT_RESET: 0x1a,
  SET_OPTION: 0x1b,
  STMT_FETCH: 0x1c,
  RESET_CONNECTION: 0x1f,
} as const

const MAX_PACKET = 0xffffff

/** Reads packets from a socket, a payload split over 16 MB packets joined again; the chunks each comes in joined once. */
export class PacketReader {
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

  /** Bytes that have come, waiting for more until there are `n`; false once the client is gone. */
  async #have(n: number): Promise<boolean> {
    while (this.#size < n) {
      if (this.#ended) return false
      if (!(await new Promise<boolean>((resolve) => (this.#waiting = resolve)))) return false
    }
    return true
  }

  /** The chunks as one buffer. */
  #joined(): Buffer {
    if (this.#chunks.length > 1) this.#chunks = [Buffer.concat(this.#chunks, this.#size)]
    return this.#chunks[0]!
  }

  /** The next payload and the sequence id of its last packet; undefined once the client is gone. */
  async next(): Promise<{ payload: Buffer; seq: number } | undefined> {
    const parts: Buffer[] = []
    for (;;) {
      if (!(await this.#have(4))) return undefined
      const length = this.#joined().readUIntLE(0, 3)
      if (!(await this.#have(4 + length))) return undefined
      const all = this.#joined()
      const seq = all[3]!
      parts.push(all.subarray(4, 4 + length))
      const rest = all.subarray(4 + length)
      this.#chunks = rest.length ? [rest] : []
      this.#size = rest.length
      if (length < MAX_PACKET) return { payload: parts.length === 1 ? parts[0]! : Buffer.concat(parts), seq }
    }
  }
}

/** Writes payloads as packets, numbering them from a sequence id each exchange starts. */
export class PacketWriter {
  seq = 0

  constructor(private readonly socket: Socket) {}

  write(payload: Buffer): void {
    for (let at = 0; ; at += MAX_PACKET) {
      const part = payload.subarray(at, at + MAX_PACKET)
      const header = Buffer.alloc(4)
      header.writeUIntLE(part.length, 0, 3)
      header[3] = this.seq++ & 0xff
      this.socket.write(Buffer.concat([header, part]))
      // A payload that fills packets exactly ends with an empty one.
      if (part.length < MAX_PACKET) return
    }
  }
}

/* Encoding. */

export function lenencInt(n: number): Buffer {
  if (n < 251) return Buffer.from([n])
  if (n < 0x10000) return Buffer.from([0xfc, n & 0xff, n >> 8])
  if (n < 0x1000000) return Buffer.from([0xfd, n & 0xff, (n >> 8) & 0xff, n >> 16])
  const b = Buffer.alloc(9)
  b[0] = 0xfe
  b.writeBigUInt64LE(BigInt(n), 1)
  return b
}

export function lenencString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return Buffer.concat([lenencInt(bytes.length), bytes])
}

const nul = (s: string) => Buffer.from(`${s}\0`, 'utf8')
const u16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

/** The server's greeting: version 10, with the scramble a client signs its password with, which Sosie never checks. */
export function handshake(connectionId: number, serverVersion: string, scramble: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([10]),
    nul(serverVersion),
    u32(connectionId),
    scramble.subarray(0, 8),
    Buffer.from([0]),
    u16(SERVER_CAPABILITIES & 0xffff),
    Buffer.from([UTF8MB4]),
    u16(STATUS.AUTOCOMMIT),
    u16(SERVER_CAPABILITIES >>> 16),
    Buffer.from([21]),
    Buffer.alloc(10),
    scramble.subarray(8, 20),
    Buffer.from([0]),
    nul('caching_sha2_password'),
  ])
}

export interface HandshakeResponse {
  capabilities: number
  user: string
  database?: string | undefined
  plugin?: string | undefined
  /** A short response asking for TLS, which Sosie did not offer. */
  ssl: boolean
}

export function readHandshakeResponse(payload: Buffer): HandshakeResponse {
  const capabilities = payload.readUInt32LE(0)
  if (payload.length <= 32) return { capabilities, user: '', ssl: (capabilities & CLIENT.SSL) !== 0 }
  let at = 32
  const cstring = () => {
    const end = payload.indexOf(0, at)
    const value = payload.subarray(at, end < 0 ? payload.length : end).toString('utf8')
    at = end < 0 ? payload.length : end + 1
    return value
  }
  const user = cstring()
  if (capabilities & CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA) {
    const [length, size] = readLenenc(payload, at)
    at += size + length
  } else if (capabilities & CLIENT.SECURE_CONNECTION) at += 1 + payload[at]!
  else cstring()
  const database = capabilities & CLIENT.CONNECT_WITH_DB && at < payload.length ? cstring() : undefined
  const plugin = capabilities & CLIENT.PLUGIN_AUTH && at < payload.length ? cstring() : undefined
  return { capabilities, user, database: database || undefined, plugin, ssl: false }
}

/** A length-encoded integer at an offset: its value and how many bytes it took. */
export function readLenenc(payload: Buffer, at: number): [number, number] {
  const first = payload[at]!
  if (first < 0xfb) return [first, 1]
  if (first === 0xfc) return [payload.readUInt16LE(at + 1), 3]
  if (first === 0xfd) return [payload.readUIntLE(at + 1, 3), 4]
  return [Number(payload.readBigUInt64LE(at + 1)), 9]
}

export function ok({
  affected = 0,
  insertId = 0,
  status = STATUS.AUTOCOMMIT as number,
  warnings = 0,
  info = '',
}: { affected?: number; insertId?: number; status?: number; warnings?: number; info?: string } = {}): Buffer {
  return Buffer.concat([Buffer.from([0]), lenencInt(affected), lenencInt(insertId), u16(status), u16(warnings), Buffer.from(info, 'utf8')])
}

export function err(code: number, sqlState: string, message: string): Buffer {
  return Buffer.concat([Buffer.from([0xff]), u16(code), Buffer.from(`#${sqlState.padEnd(5, '0').slice(0, 5)}`), Buffer.from(message, 'utf8')])
}

/** COM_STMT_PREPARE's answer: the statement's id, and how many columns and parameters it has; their definitions follow. */
export function prepareOk(id: number, columns: number, params: number): Buffer {
  return Buffer.concat([Buffer.from([0]), u32(id), u16(columns), u16(params), Buffer.from([0]), u16(0)])
}

export function eof(status: number = STATUS.AUTOCOMMIT, warnings = 0): Buffer {
  return Buffer.concat([Buffer.from([0xfe]), u16(warnings), u16(status)])
}

/** A result column, as the server describes it: where it came from, and its type. */
export interface Column {
  schema: string
  table: string
  orgTable: string
  name: string
  orgName: string
  characterSet: number
  length: number
  type: number
  flags: number
  decimals: number
}

export function columnDefinition(c: Column): Buffer {
  return Buffer.concat([
    lenencString('def'),
    lenencString(c.schema),
    lenencString(c.table),
    lenencString(c.orgTable),
    lenencString(c.name),
    lenencString(c.orgName),
    Buffer.from([0x0c]),
    u16(c.characterSet),
    u32(c.length),
    Buffer.from([c.type]),
    u16(c.flags),
    Buffer.from([c.decimals, 0, 0]),
  ])
}

/** A row of the text protocol: each value as its bytes, NULL as 0xfb. */
export function textRow(values: (Buffer | null)[]): Buffer {
  return Buffer.concat(values.map((v) => (v === null ? Buffer.from([0xfb]) : lenencString(v))))
}
