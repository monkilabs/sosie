import type { Socket } from 'node:net'

/**
 * The Postgres wire protocol, version 3.0, from the server's side: what a
 * client sends, read off a socket, and what Sosie sends back.
 */

export type FrontendMessage =
  | { type: 'ssl' }
  | { type: 'gss' }
  | { type: 'cancel'; pid: number; secret: number }
  | { type: 'startup'; minor: number; params: Record<string, string> }
  | { type: 'query'; text: string }
  | { type: 'parse'; name: string; text: string; types: number[] }
  | { type: 'bind'; portal: string; statement: string; formats: number[]; params: (Buffer | null)[]; results: number[] }
  | { type: 'describe'; kind: 'S' | 'P'; name: string }
  | { type: 'execute'; portal: string; maxRows: number }
  | { type: 'close'; kind: 'S' | 'P'; name: string }
  | { type: 'sync' }
  | { type: 'flush' }
  | { type: 'terminate' }
  | { type: 'unsupported'; code: string }

const SSL_REQUEST = 80877103
const GSS_REQUEST = 80877104
const CANCEL_REQUEST = 80877102
const MAX_MESSAGE = 1 << 30

/** Reads frontend messages from a socket, one at a time. */
export class Reader {
  #buffer: Buffer = Buffer.alloc(0)
  #startup = true
  #queue: FrontendMessage[] = []
  #waiting: ((message: FrontendMessage | null) => void) | undefined
  #ended = false

  constructor(socket: Socket) {
    socket.on('data', (chunk) => this.#push(chunk as Buffer))
    socket.on('close', () => this.#end())
    socket.on('error', () => this.#end())
  }

  /** The next message, or null when the client is gone. */
  next(): Promise<FrontendMessage | null> {
    const message = this.#queue.shift()
    if (message) return Promise.resolve(message)
    if (this.#ended) return Promise.resolve(null)
    return new Promise((resolve) => (this.#waiting = resolve))
  }

  #deliver(message: FrontendMessage | null): void {
    const waiting = this.#waiting
    if (waiting) {
      this.#waiting = undefined
      waiting(message)
    } else if (message) this.#queue.push(message)
  }

  #end(): void {
    this.#ended = true
    this.#deliver(null)
  }

  /** A message that does not parse ends this connection, never the process. */
  #push(chunk: Buffer): void {
    if (this.#ended) return
    try {
      this.#read(chunk)
    } catch {
      this.#buffer = Buffer.alloc(0)
      this.#end()
    }
  }

  #read(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
    for (;;) {
      const headerLength = this.#startup ? 0 : 1
      if (this.#buffer.length < headerLength + 4) return
      const length = this.#buffer.readInt32BE(headerLength)
      if (length < 4 || length > MAX_MESSAGE) return this.#end()
      const total = headerLength + length
      if (this.#buffer.length < total) return
      const body = this.#buffer.subarray(headerLength + 4, total)
      const code = this.#startup ? '' : String.fromCharCode(this.#buffer[0]!)
      this.#buffer = this.#buffer.subarray(total)
      this.#deliver(this.#startup ? this.#startupMessage(body) : decode(code, body))
    }
  }

  #startupMessage(body: Buffer): FrontendMessage {
    const code = body.readInt32BE(0)
    if (code === SSL_REQUEST) return { type: 'ssl' }
    if (code === GSS_REQUEST) return { type: 'gss' }
    if (code === CANCEL_REQUEST) return { type: 'cancel', pid: body.readInt32BE(4), secret: body.readInt32BE(8) }
    this.#startup = false
    const params: Record<string, string> = {}
    const parts = body.subarray(4).toString('utf8').split('\0')
    for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) params[parts[i]!] = parts[i + 1]!
    return { type: 'startup', minor: code & 0xffff, params }
  }
}

class Cursor {
  offset = 0
  constructor(readonly body: Buffer) {}
  cstring(): string {
    const end = this.body.indexOf(0, this.offset)
    if (end < 0) throw new RangeError('A string without its end')
    const value = this.body.toString('utf8', this.offset, end)
    this.offset = end + 1
    return value
  }
  int16(): number {
    const value = this.body.readInt16BE(this.offset)
    this.offset += 2
    return value
  }
  int32(): number {
    const value = this.body.readInt32BE(this.offset)
    this.offset += 4
    return value
  }
  bytes(length: number): Buffer {
    const value = this.body.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
}

function decode(code: string, body: Buffer): FrontendMessage {
  const c = new Cursor(body)
  switch (code) {
    case 'Q':
      return { type: 'query', text: c.cstring() }
    case 'P': {
      const name = c.cstring()
      const text = c.cstring()
      const types = Array.from({ length: c.int16() }, () => c.int32())
      return { type: 'parse', name, text, types }
    }
    case 'B': {
      const portal = c.cstring()
      const statement = c.cstring()
      const formats = Array.from({ length: c.int16() }, () => c.int16())
      const params = Array.from({ length: c.int16() }, () => {
        const length = c.int32()
        return length < 0 ? null : Buffer.from(c.bytes(length))
      })
      const results = Array.from({ length: c.int16() }, () => c.int16())
      return { type: 'bind', portal, statement, formats, params, results }
    }
    case 'D':
      return { type: 'describe', kind: c.bytes(1).toString() as 'S' | 'P', name: c.cstring() }
    case 'E':
      return { type: 'execute', portal: c.cstring(), maxRows: c.int32() }
    case 'C':
      return { type: 'close', kind: c.bytes(1).toString() as 'S' | 'P', name: c.cstring() }
    case 'S':
      return { type: 'sync' }
    case 'H':
      return { type: 'flush' }
    case 'X':
      return { type: 'terminate' }
    default:
      return { type: 'unsupported', code }
  }
}

/* Backend messages. */

function message(code: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(5)
  header.write(code, 0, 'latin1')
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

const cstring = (s: string) => Buffer.from(`${s}\0`, 'utf8')
const int16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeInt16BE(n)
  return b
}
const int32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n | 0)
  return b
}

export interface ColumnDescription {
  name: string
  tableID: number
  columnID: number
  dataTypeID: number
  dataTypeSize: number
  dataTypeModifier: number
}

/** The fields of an ErrorResponse or NoticeResponse, by their protocol codes. */
export interface Report {
  severity: string
  code: string
  message: string
  detail?: string | undefined
  hint?: string | undefined
  position?: string | undefined
}

export const backend = {
  authenticationOk: () => message('R', int32(0)),
  parameterStatus: (name: string, value: string) => message('S', cstring(name), cstring(value)),
  backendKeyData: (pid: number, secret: number) => message('K', int32(pid), int32(secret)),
  negotiateProtocolVersion: (minor: number, unrecognized: string[]) =>
    message('v', int32(minor), int32(unrecognized.length), ...unrecognized.map(cstring)),
  readyForQuery: (status: string) => message('Z', Buffer.from(status, 'latin1')),
  parseComplete: () => message('1'),
  bindComplete: () => message('2'),
  closeComplete: () => message('3'),
  noData: () => message('n'),
  portalSuspended: () => message('s'),
  emptyQuery: () => message('I'),
  commandComplete: (tag: string) => message('C', cstring(tag)),
  parameterDescription: (types: number[]) => message('t', int16(types.length), ...types.map(int32)),
  rowDescription: (columns: ColumnDescription[]) =>
    message(
      'T',
      int16(columns.length),
      ...columns.flatMap((c) => [
        cstring(c.name),
        int32(c.tableID),
        int16(c.columnID),
        int32(c.dataTypeID),
        int16(c.dataTypeSize),
        int32(c.dataTypeModifier),
        int16(0),
      ]),
    ),
  dataRow: (values: (string | null)[]) =>
    message(
      'D',
      int16(values.length),
      ...values.flatMap((v) => {
        if (v === null) return [int32(-1)]
        const bytes = Buffer.from(v, 'utf8')
        return [int32(bytes.length), bytes]
      }),
    ),
  error: (report: Report) => message('E', ...fields(report)),
  notice: (report: Report) => message('N', ...fields(report)),
}

function fields(report: Report): Buffer[] {
  const out = [
    Buffer.from('S'),
    cstring(report.severity),
    Buffer.from('V'),
    cstring(report.severity),
    Buffer.from('C'),
    cstring(report.code),
    Buffer.from('M'),
    cstring(report.message),
  ]
  if (report.detail) out.push(Buffer.from('D'), cstring(report.detail))
  if (report.hint) out.push(Buffer.from('H'), cstring(report.hint))
  if (report.position) out.push(Buffer.from('P'), cstring(report.position))
  out.push(Buffer.from([0]))
  return out
}
