import type { Near } from './guard.js'
import { lenencString, readLenenc, type Column } from './protocol.js'
import { quote } from './rewrite.js'

/**
 * MySQL's binary protocol, as prepared statements use it: the parameters COM_STMT_EXECUTE carries, and result rows.
 * Sosie runs a prepared statement as text upstream, each parameter written into it as a literal, and answers the
 * client in binary: so a statement is checked, turned back and faked as one sent as text is.
 */

export const TYPE = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  NEWDATE: 14,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
} as const

/** A column flag: the integer is unsigned. */
const UNSIGNED = 32

const BLOBS = new Set<number>([TYPE.TINY_BLOB, TYPE.MEDIUM_BLOB, TYPE.LONG_BLOB, TYPE.BLOB, TYPE.GEOMETRY, TYPE.BIT])

/** A parameter as the client bound it. */
export type Param =
  | { kind: 'null' }
  | { kind: 'integer'; text: string }
  | { kind: 'double'; value: number }
  | { kind: 'decimal'; text: string }
  | { kind: 'string'; bytes: Buffer }
  | { kind: 'binary'; bytes: Buffer }
  | { kind: 'temporal'; text: string; type: 'date' | 'datetime' | 'time' }

/** A COM_STMT_EXECUTE that does not read as one: MySQL's own answer is "Incorrect arguments". */
export class ArgumentsError extends Error {}

export interface Execute {
  id: number
  /** The client asked for a cursor: Sosie opens none, and answers with the rows, as MySQL does for a statement that cannot have one. */
  flags: number
  params: Param[]
  /** The types the client bound, kept for an execution that sends none. */
  types: Buffer | undefined
}

/**
 * Read COM_STMT_EXECUTE's parameters: a null bitmap, whether types follow (else those bound last), the types, then
 * each value. A parameter sent with COM_STMT_SEND_LONG_DATA is not in the packet: its data is.
 */
export function readExecute(payload: Buffer, count: number, bound: Buffer | undefined, long: ReadonlyMap<number, Buffer[]>): Execute {
  if (payload.length < 10) throw new ArgumentsError()
  const id = payload.readUInt32LE(1)
  const flags = payload[5]!
  if (!count) return { id, flags, params: [], types: bound }
  let at = 10
  const nulls = payload.subarray(at, (at += (count + 7) >> 3))
  if (at >= payload.length && !bound) throw new ArgumentsError()
  let types = bound
  if (payload[at++] === 1) types = payload.subarray(at, (at += count * 2))
  if (!types || types.length < count * 2) throw new ArgumentsError()
  const params: Param[] = []
  for (let i = 0; i < count; i++) {
    const type = types[i * 2]!
    const unsigned = (types[i * 2 + 1]! & 0x80) !== 0
    const data = long.get(i)
    if (data) {
      params.push(stringParam(type, Buffer.concat(data)))
      continue
    }
    if (nulls[i >> 3]! & (1 << (i & 7)) || type === TYPE.NULL) {
      params.push({ kind: 'null' })
      continue
    }
    const [param, size] = readValue(payload, at, type, unsigned)
    params.push(param)
    at += size
  }
  return { id, flags, params, types: Buffer.from(types) }
}

function readValue(p: Buffer, at: number, type: number, unsigned: boolean): [Param, number] {
  const need = (n: number) => {
    if (at + n > p.length) throw new ArgumentsError()
  }
  switch (type) {
    case TYPE.TINY:
      need(1)
      return [{ kind: 'integer', text: String(unsigned ? p.readUInt8(at) : p.readInt8(at)) }, 1]
    case TYPE.SHORT:
    case TYPE.YEAR:
      need(2)
      return [{ kind: 'integer', text: String(unsigned ? p.readUInt16LE(at) : p.readInt16LE(at)) }, 2]
    case TYPE.LONG:
    case TYPE.INT24:
      need(4)
      return [{ kind: 'integer', text: String(unsigned ? p.readUInt32LE(at) : p.readInt32LE(at)) }, 4]
    case TYPE.LONGLONG:
      need(8)
      return [{ kind: 'integer', text: String(unsigned ? p.readBigUInt64LE(at) : p.readBigInt64LE(at)) }, 8]
    case TYPE.FLOAT:
      need(4)
      return [{ kind: 'double', value: p.readFloatLE(at) }, 4]
    case TYPE.DOUBLE:
      need(8)
      return [{ kind: 'double', value: p.readDoubleLE(at) }, 8]
    case TYPE.DATE:
    case TYPE.NEWDATE:
    case TYPE.DATETIME:
    case TYPE.TIMESTAMP: {
      need(1)
      const length = p[at]!
      need(1 + length)
      return [{ kind: 'temporal', text: readDate(p.subarray(at + 1, at + 1 + length), type === TYPE.DATE || type === TYPE.NEWDATE), type: type === TYPE.DATE || type === TYPE.NEWDATE ? 'date' : 'datetime' }, 1 + length]
    }
    case TYPE.TIME: {
      need(1)
      const length = p[at]!
      need(1 + length)
      return [{ kind: 'temporal', text: readTime(p.subarray(at + 1, at + 1 + length)), type: 'time' }, 1 + length]
    }
    default: {
      need(1)
      // The length's own size first: 0xfc, 0xfd and 0xfe say 2, 3 or 8 more bytes of it.
      need(({ 0xfc: 3, 0xfd: 4, 0xfe: 9 } as Record<number, number>)[p[at]!] ?? 1)
      const [length, size] = readLenenc(p, at)
      need(size + length)
      return [stringParam(type, p.subarray(at + size, at + size + length)), size + length]
    }
  }
}

function stringParam(type: number, bytes: Buffer): Param {
  if (type === TYPE.DECIMAL || type === TYPE.NEWDECIMAL) {
    const text = bytes.toString('latin1')
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return { kind: 'decimal', text }
  }
  return BLOBS.has(type) ? { kind: 'binary', bytes } : { kind: 'string', bytes }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

function fraction(micro: number): string {
  return micro ? `.${pad(micro, 6)}` : ''
}

function readDate(b: Buffer, dateOnly: boolean): string {
  const year = b.length >= 4 ? b.readUInt16LE(0) : 0
  const month = b.length >= 4 ? b[2]! : 0
  const day = b.length >= 4 ? b[3]! : 0
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`
  if (dateOnly) return date
  const time = b.length >= 7 ? [b[4]!, b[5]!, b[6]!] : [0, 0, 0]
  const micro = b.length >= 11 ? b.readUInt32LE(7) : 0
  return `${date} ${time.map((n) => pad(n)).join(':')}${fraction(micro)}`
}

function readTime(b: Buffer): string {
  if (b.length < 8) return '00:00:00'
  const negative = b[0] === 1
  const hours = b.readUInt32LE(1) * 24 + b[5]!
  const micro = b.length >= 12 ? b.readUInt32LE(8) : 0
  return `${negative ? '-' : ''}${pad(hours)}:${pad(b[6]!)}:${pad(b[7]!)}${fraction(micro)}`
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function text(bytes: Buffer): string | undefined {
  try {
    return utf8.decode(bytes)
  } catch {
    return undefined
  }
}

const isBytes = (near: Near) => !!near && near !== 'catalog' && near.type.kind === 'bytes'

/**
 * The texts a fake in this parameter may have been shown as, to look it up by: bytes as the hex text the core fakes
 * them in, a date or time with its fraction of a second as long as its column's, whatever that is.
 */
export function lookupTexts(param: Param, near: Near): string[] {
  switch (param.kind) {
    case 'null':
      return []
    case 'integer':
    case 'decimal':
      return [param.text]
    case 'double':
      return Number.isFinite(param.value) ? [String(param.value)] : []
    case 'string':
    case 'binary': {
      if (isBytes(near)) return [`\\x${param.bytes.toString('hex')}`]
      const t = text(param.bytes)
      return t === undefined ? [] : [t]
    }
    case 'temporal':
      return temporalTexts(param.text)
  }
}

/** A fraction of a second without its trailing zeros. */
function trimFraction(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value
}

/** A date, time or datetime with its fraction cut to each length that drops only zeros; a midnight datetime as its date. */
export function temporalTexts(value: string): string[] {
  const m = /^(.*?)(?:\.(\d{1,6}))?$/.exec(value)!
  const whole = m[1]!
  const digits = (m[2] ?? '').padEnd(6, '0')
  const out = new Set<string>()
  for (let p = 6; p >= 0; p--) if (/^0*$/.test(digits.slice(p))) out.add(p ? `${whole}.${digits.slice(0, p)}` : whole)
  if (/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(whole) && /^0*$/.test(digits)) out.add(whole.slice(0, 10))
  return [...out]
}

/**
 * The literal a parameter is written as in the statement sent upstream, with the real value it stands for when it
 * was a fake. Spaced, so it never runs into the text around it (?AND reads as 5 AND). Undefined for a value MySQL
 * has no literal for (NaN, Infinity).
 */
export function paramLiteral(param: Param, real: string | undefined, near: Near): string | undefined {
  const literal = ((): string | undefined => {
    switch (param.kind) {
      case 'null':
        return 'NULL'
      case 'integer':
      case 'decimal':
        return number(real ?? param.text)
      case 'double':
        if (real !== undefined) return number(real)
        return Number.isFinite(param.value) ? number(doubleText(param.value)) : undefined
      case 'temporal':
        return quote(real ?? trimFraction(param.text))
      case 'string':
      case 'binary': {
        if (real !== undefined) {
          if (isBytes(near) && /^\\x([0-9a-f]{2})*$/i.test(real)) return `X'${real.slice(2)}'`
          // Binary stays binary: a BLOB parameter is a binary string to MySQL.
          return param.kind === 'binary' ? `X'${Buffer.from(real, 'utf8').toString('hex')}'` : quote(real)
        }
        const t = param.kind === 'string' ? text(param.bytes) : undefined
        return t === undefined ? `X'${param.bytes.toString('hex')}'` : quote(t)
      }
    }
  })()
  return literal === undefined ? undefined : ` ${literal} `
}

/** A number as a literal, a negative one in parentheses so it never follows a minus as a comment; other text quoted. */
function number(value: string): string {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return quote(value)
  return value.startsWith('-') ? `(${value})` : value
}

/** A double as MySQL reads one: a whole number as itself, anything else with an exponent, which makes it a DOUBLE, not a DECIMAL. */
function doubleText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 53) return String(n)
  return n.toExponential()
}

/* Result rows. */

/**
 * A row of the binary protocol, from the text MySQL sent as text and Sosie faked: each value in its column's binary
 * form. A value that does not read as its type (a fake out of its form) goes as NULL rather than as something else.
 */
export function binaryRow(values: (Buffer | null)[], columns: Column[]): Buffer {
  const nulls = Buffer.alloc((columns.length + 7 + 2) >> 3)
  const parts: Buffer[] = [Buffer.from([0]), nulls]
  values.forEach((value, i) => {
    const encoded = value === null ? undefined : encode(value, columns[i]!)
    if (encoded === undefined) nulls[(i + 2) >> 3]! |= 1 << ((i + 2) & 7)
    else parts.push(encoded)
  })
  return Buffer.concat(parts)
}

function encode(value: Buffer, column: Column): Buffer | undefined {
  const unsigned = (column.flags & UNSIGNED) !== 0
  switch (column.type) {
    case TYPE.TINY:
      return integer(value, 1, unsigned)
    case TYPE.SHORT:
    case TYPE.YEAR:
      return integer(value, 2, unsigned)
    case TYPE.LONG:
    case TYPE.INT24:
      return integer(value, 4, unsigned)
    case TYPE.LONGLONG:
      return integer(value, 8, unsigned)
    case TYPE.FLOAT:
    case TYPE.DOUBLE: {
      const n = Number(value.toString('latin1'))
      if (Number.isNaN(n) && !/nan/i.test(value.toString('latin1'))) return undefined
      const b = Buffer.alloc(column.type === TYPE.FLOAT ? 4 : 8)
      if (column.type === TYPE.FLOAT) b.writeFloatLE(n)
      else b.writeDoubleLE(n)
      return b
    }
    case TYPE.DATE:
    case TYPE.NEWDATE:
    case TYPE.DATETIME:
    case TYPE.TIMESTAMP:
      return date(value.toString('latin1'))
    case TYPE.TIME:
      return time(value.toString('latin1'))
    case TYPE.NULL:
      return undefined
    default:
      return lenencString(value)
  }
}

function integer(value: Buffer, bytes: 1 | 2 | 4 | 8, unsigned: boolean): Buffer | undefined {
  const text = value.toString('latin1')
  if (!/^-?\d+$/.test(text)) return undefined
  // A value always fits its column; were a fake not to, it wraps, the same way each time.
  const n = unsigned ? BigInt.asUintN(bytes * 8, BigInt(text)) : BigInt.asIntN(bytes * 8, BigInt(text))
  const b = Buffer.alloc(bytes)
  if (bytes === 8) unsigned ? b.writeBigUInt64LE(n) : b.writeBigInt64LE(n)
  else if (unsigned) b.writeUIntLE(Number(n), 0, bytes)
  else b.writeIntLE(Number(n), 0, bytes)
  return b
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/

/** A date or datetime: its length says how much of it follows, nothing for all zeros. */
function date(text: string): Buffer | undefined {
  const m = DATE.exec(text)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number]
  const micro = Number((m[7] ?? '').padEnd(6, '0') || 0)
  const length = micro ? 11 : h || mi || s ? 7 : y || mo || d ? 4 : 0
  const b = Buffer.alloc(1 + length)
  b[0] = length
  if (length >= 4) {
    b.writeUInt16LE(y, 1)
    b[3] = mo
    b[4] = d
  }
  if (length >= 7) {
    b[5] = h
    b[6] = mi
    b[7] = s
  }
  if (length === 11) b.writeUInt32LE(micro, 8)
  return b
}

/** A time, as days and a time of day: its length says how much follows, nothing for zero. */
function time(text: string): Buffer | undefined {
  const m = /^(-)?(\d+):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text)
  if (!m) return undefined
  const hours = Number(m[2])
  const [mi, s] = [Number(m[3]), Number(m[4])]
  const micro = Number((m[5] ?? '').padEnd(6, '0') || 0)
  const length = micro ? 12 : hours || mi || s ? 8 : 0
  const b = Buffer.alloc(1 + length)
  b[0] = length
  if (length) {
    b[1] = m[1] ? 1 : 0
    b.writeUInt32LE(Math.floor(hours / 24), 2)
    b[6] = hours % 24
    b[7] = mi
    b[8] = s
  }
  if (length === 12) b.writeUInt32LE(micro, 9)
  return b
}
