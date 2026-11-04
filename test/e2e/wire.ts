import { connect } from 'node:net'

/** A frontend message: its code, length and body. */
export function typed(code: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(code)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

/**
 * Talk to an endpoint message by message, as a client a driver library hides:
 * start up, send the messages, and return the codes of what came back after
 * start-up, until the last ReadyForQuery.
 */
export function raw(port: number, messages: Buffer[], timeout = 3000): Promise<string[]> {
  const params = Buffer.from('user\0kim\0database\0app\0\0')
  const startup = Buffer.alloc(8)
  startup.writeInt32BE(8 + params.length)
  startup.writeInt32BE(196608, 4)
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.concat([startup, params])))
    let buffer = Buffer.alloc(0)
    let started = false
    const codes: string[] = []
    const ready = () => codes.filter((c) => c === 'Z').length
    const expected = messages.filter((m) => m[0] === 0x53 || m[0] === 0x46 || m[0] === 0x51).length
    const timer = setTimeout(() => (socket.destroy(), reject(new Error(`no answer: ${codes.join(' ')}`))), timeout)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer])
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        const code = String.fromCharCode(buffer[0]!)
        buffer = buffer.subarray(1 + buffer.readInt32BE(1))
        if (!started) {
          if (code === 'Z') {
            started = true
            socket.write(Buffer.concat(messages))
          }
          continue
        }
        if (code === 'E' || code === 'Z') codes.push(code)
        // A Query sent before Sync after an error is discarded: one ReadyForQuery per F and S.
        if (ready() >= expected - messages.filter((m) => m[0] === 0x51).length) {
          clearTimeout(timer)
          socket.end()
          resolve(codes)
        }
      }
    })
    socket.on('error', reject)
  })
}

const cstr = (s: string) => Buffer.from(`${s}\0`)
function i16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeInt16BE(n)
  return b
}
function i32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n)
  return b
}

/** What an extended-protocol query returned, as a binary driver sees it: each column's type and format, rows as bytes. */
export interface Extended {
  types: number[]
  formats: number[]
  rows: (Buffer | null)[][]
  error?: { code: string; message: string }
}

/**
 * One statement by the extended protocol, as asyncpg or pgx sends it: Parse with the parameter types given,
 * Bind with each parameter's format and the result formats, Describe, Execute, Sync.
 */
export function extended(
  port: number,
  sql: string,
  {
    params = [],
    paramTypes = [],
    resultFormats = [1],
    before,
  }: { params?: { value: Buffer | null; format: 0 | 1 }[]; paramTypes?: number[]; resultFormats?: number[]; before?: string } = {},
): Promise<Extended> {
  const messages = [
    // A simple Query first, on the same connection: a SET the statement then runs under.
    ...(before ? [typed('Q', cstr(before))] : []),
    typed('P', Buffer.concat([cstr(''), cstr(sql), i16(paramTypes.length), ...paramTypes.map(i32)])),
    typed(
      'B',
      Buffer.concat([
        cstr(''),
        cstr(''),
        i16(params.length),
        ...params.map((p) => i16(p.format)),
        i16(params.length),
        ...params.flatMap((p) => (p.value === null ? [i32(-1)] : [i32(p.value.length), p.value])),
        i16(resultFormats.length),
        ...resultFormats.map(i16),
      ]),
    ),
    typed('D', Buffer.concat([Buffer.from('P'), cstr('')])),
    typed('E', Buffer.concat([cstr(''), i32(0)])),
    typed('S', Buffer.alloc(0)),
  ]
  const params0 = Buffer.from('user\0kim\0database\0app\0\0')
  const startup = Buffer.alloc(8)
  startup.writeInt32BE(8 + params0.length)
  startup.writeInt32BE(196608, 4)
  return new Promise((resolve, reject) => {
    const result: Extended = { types: [], formats: [], rows: [] }
    const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.concat([startup, params0])))
    let buffer = Buffer.alloc(0)
    let started = false
    let pending = before ? 2 : 1
    const timer = setTimeout(() => (socket.destroy(), reject(new Error('no answer'))), 5000)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer])
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        const code = String.fromCharCode(buffer[0]!)
        const body = buffer.subarray(5, 1 + buffer.readInt32BE(1))
        buffer = buffer.subarray(1 + buffer.readInt32BE(1))
        if (!started) {
          if (code === 'Z') {
            started = true
            socket.write(Buffer.concat(messages))
          }
          continue
        }
        if (code === 'T') {
          let at = 2
          for (let i = 0; i < body.readInt16BE(0); i++) {
            at = body.indexOf(0, at) + 1
            result.types.push(body.readUInt32BE(at + 6))
            result.formats.push(body.readInt16BE(at + 16))
            at += 18
          }
        } else if (code === 'D') {
          const row: (Buffer | null)[] = []
          for (let i = 0, at = 2; i < body.readInt16BE(0); i++) {
            const length = body.readInt32BE(at)
            row.push(length < 0 ? null : Buffer.from(body.subarray(at + 4, at + 4 + length)))
            at += 4 + Math.max(length, 0)
          }
          result.rows.push(row)
        } else if (code === 'E') {
          const fields = new Map<string, string>()
          for (let at = 0; body[at]; ) {
            const end = body.indexOf(0, at + 1)
            fields.set(String.fromCharCode(body[at]!), body.subarray(at + 1, end).toString())
            at = end + 1
          }
          result.error = { code: fields.get('C') ?? '', message: fields.get('M') ?? '' }
        } else if (code === 'Z' && --pending === 0) {
          clearTimeout(timer)
          socket.end()
          resolve(result)
        }
      }
    })
    socket.on('error', reject)
  })
}
