import type { FieldType } from '@sosie/core'
import { Cursor, u8, u16, u32, u64 } from './tds.js'

/** TDS's data types by their TYPE_INFO byte (MS-TDS 2.2.5.4). */
export const TYPE = {
  NULL: 0x1f,
  INT1: 0x30,
  BIT: 0x32,
  INT2: 0x34,
  INT4: 0x38,
  DATETIM4: 0x3a,
  FLT4: 0x3b,
  MONEY: 0x3c,
  DATETIME: 0x3d,
  FLT8: 0x3e,
  MONEY4: 0x7a,
  INT8: 0x7f,
  GUID: 0x24,
  INTN: 0x26,
  DECIMAL: 0x37,
  NUMERIC: 0x3f,
  BITN: 0x68,
  DECIMALN: 0x6a,
  NUMERICN: 0x6c,
  FLTN: 0x6d,
  MONEYN: 0x6e,
  DATETIMN: 0x6f,
  DATE: 0x28,
  TIME: 0x29,
  DATETIME2: 0x2a,
  DATETIMEOFFSET: 0x2b,
  BIGVARBINARY: 0xa5,
  BIGVARCHAR: 0xa7,
  BIGBINARY: 0xad,
  BIGCHAR: 0xaf,
  NVARCHAR: 0xe7,
  NCHAR: 0xef,
  XML: 0xf1,
  UDT: 0xf0,
  TEXT: 0x23,
  IMAGE: 0x22,
  NTEXT: 0x63,
  SSVARIANT: 0x62,
} as const

const FIXED: Record<number, number> = {
  [TYPE.NULL]: 0,
  [TYPE.INT1]: 1,
  [TYPE.BIT]: 1,
  [TYPE.INT2]: 2,
  [TYPE.INT4]: 4,
  [TYPE.DATETIM4]: 4,
  [TYPE.FLT4]: 4,
  [TYPE.MONEY]: 8,
  [TYPE.DATETIME]: 8,
  [TYPE.FLT8]: 8,
  [TYPE.MONEY4]: 4,
  [TYPE.INT8]: 8,
}

const BYTELEN = new Set<number>([TYPE.GUID, TYPE.INTN, TYPE.BITN, TYPE.FLTN, TYPE.MONEYN, TYPE.DATETIMN])
const SCALED = new Set<number>([TYPE.DECIMALN, TYPE.NUMERICN, TYPE.DECIMAL, TYPE.NUMERIC])
const TIMES = new Set<number>([TYPE.TIME, TYPE.DATETIME2, TYPE.DATETIMEOFFSET])
const CHARS = new Set<number>([TYPE.BIGVARCHAR, TYPE.BIGCHAR, TYPE.NVARCHAR, TYPE.NCHAR])
const BINARIES = new Set<number>([TYPE.BIGVARBINARY, TYPE.BIGBINARY])
const LONG = new Set<number>([TYPE.TEXT, TYPE.NTEXT, TYPE.IMAGE])
const UNICODE = new Set<number>([TYPE.NVARCHAR, TYPE.NCHAR, TYPE.NTEXT])

/** How a type's value is laid out in a row. */
export type Layout = 'fixed' | 'bytelen' | 'ushort' | 'plp' | 'text' | 'variant'

/** A column's or a parameter's type, as TYPE_INFO gives it; `raw` is TYPE_INFO's own bytes, written back as they came. */
export interface TypeInfo {
  id: number
  layout: Layout
  /** The most bytes a value may take: a fixed type's size, or the length TYPE_INFO declares (0xffff for a max type). */
  length: number
  precision?: number
  scale?: number
  collation?: Buffer
  raw: Buffer
}

/** Read one TYPE_INFO. Text, ntext and image name their table after it in COLMETADATA, which reads that itself. */
export function readTypeInfo(c: Cursor): TypeInfo {
  const start = c.at
  const id = c.u8()
  const t: Omit<TypeInfo, 'raw'> = { id, layout: 'fixed', length: 0 }
  if (id in FIXED) t.length = FIXED[id]!
  else if (BYTELEN.has(id)) Object.assign(t, { layout: 'bytelen', length: c.u8() })
  else if (SCALED.has(id)) Object.assign(t, { layout: 'bytelen', length: c.u8(), precision: c.u8(), scale: c.u8() })
  else if (id === TYPE.DATE) Object.assign(t, { layout: 'bytelen', length: 3 })
  else if (TIMES.has(id)) {
    const scale = c.u8()
    Object.assign(t, { layout: 'bytelen', scale, length: timeBytes(scale) + (id === TYPE.TIME ? 0 : 3) + (id === TYPE.DATETIMEOFFSET ? 2 : 0) })
  } else if (BINARIES.has(id) || CHARS.has(id)) {
    t.length = c.u16()
    t.layout = t.length === 0xffff ? 'plp' : 'ushort'
    if (CHARS.has(id)) t.collation = c.bytes(5)
  } else if (LONG.has(id)) {
    Object.assign(t, { layout: 'text', length: c.u32() })
    if (id !== TYPE.IMAGE) t.collation = c.bytes(5)
  } else if (id === TYPE.SSVARIANT) Object.assign(t, { layout: 'variant', length: c.u32() })
  else if (id === TYPE.XML) {
    if (c.u8()) {
      c.bvarchar()
      c.bvarchar()
      c.usvarchar()
    }
    Object.assign(t, { layout: 'plp', length: 0xffff })
  } else if (id === TYPE.UDT) {
    c.u16()
    c.bvarchar()
    c.bvarchar()
    c.bvarchar()
    c.usvarchar()
    Object.assign(t, { layout: 'plp', length: 0xffff })
  } else throw new UnknownTypeError(id)
  return { ...t, raw: Buffer.from(c.buf.subarray(start, c.at)) }
}

export class UnknownTypeError extends Error {
  constructor(readonly id: number) {
    super(`A column of type 0x${id.toString(16)}, which Sosie does not read.`)
  }
}

/** The bytes a time of a scale (its digits after the second) takes. */
function timeBytes(scale: number): number {
  return scale <= 2 ? 3 : scale <= 4 ? 4 : 5
}

const PLP_NULL = 0xffffffffffffffffn
const PLP_UNKNOWN = 0xfffffffffffffffen

/** One value of a row: its bytes as TDS lays them out without their length, or null. Text, ntext and image keep their text pointer and timestamp. */
export interface RawValue {
  bytes: Buffer | null
  /** Text, ntext and image: their text pointer and timestamp, written back before the value. */
  pointer?: Buffer
}

/** Read one value of a type from a row. */
export function readValue(c: Cursor, t: TypeInfo): RawValue {
  switch (t.layout) {
    case 'fixed':
      return { bytes: t.id === TYPE.NULL ? null : c.bytes(t.length) }
    case 'bytelen': {
      const n = c.u8()
      return { bytes: n === 0 ? null : c.bytes(n) }
    }
    case 'ushort': {
      const n = c.u16()
      return { bytes: n === 0xffff ? null : c.bytes(n) }
    }
    case 'plp': {
      const total = c.u64()
      if (total === PLP_NULL) return { bytes: null }
      const parts: Buffer[] = []
      for (let n = c.u32(); n; n = c.u32()) parts.push(c.bytes(n))
      return { bytes: Buffer.concat(parts) }
    }
    case 'text': {
      const p = c.u8()
      if (!p) return { bytes: null }
      const pointer = c.bytes(p + 8)
      return { bytes: c.bytes(c.u32()), pointer }
    }
    case 'variant': {
      const n = c.u32()
      return { bytes: n === 0 ? null : c.bytes(n) }
    }
  }
}

/** One value of a type, as a row or a parameter carries it: its length, then its bytes. */
export function writeValue(t: TypeInfo, value: RawValue): Buffer {
  const b = value.bytes
  switch (t.layout) {
    case 'fixed':
      return b ?? Buffer.alloc(t.length)
    case 'bytelen':
      return b === null ? u8(0) : Buffer.concat([u8(b.length), b])
    case 'ushort':
      return b === null ? u16(0xffff) : Buffer.concat([u16(b.length), b])
    case 'plp': {
      if (b === null) return u64(PLP_NULL)
      return Buffer.concat([u64(b.length), ...(b.length ? [u32(b.length), b] : []), u32(0)])
    }
    case 'text': {
      if (b === null) return u8(0)
      // A text pointer of 16 bytes and a timestamp of 8, for a value that came with none.
      const pointer = value.pointer ?? Buffer.alloc(24)
      return Buffer.concat([u8(pointer.length - 8), pointer, u32(b.length), b])
    }
    case 'variant':
      return b === null ? u32(0) : Buffer.concat([u32(b.length), b])
  }
}

/** Whether a value of this layout may be null: a fixed type's may not. */
export const nullable = (t: TypeInfo) => t.layout !== 'fixed'

/* The core fakes values as text: each type's text form, and back. */

/** A type's values in the core's terms, from TYPE_INFO: what a result column no field holds is faked as. */
export function fieldTypeOf(t: TypeInfo): FieldType {
  switch (t.id) {
    case TYPE.INT1:
      return { kind: 'integer', bytes: 1 }
    case TYPE.INT2:
      return { kind: 'integer', bytes: 2 }
    case TYPE.INT4:
      return { kind: 'integer', bytes: 4 }
    case TYPE.INT8:
      return { kind: 'integer', bytes: 8 }
    case TYPE.INTN:
      return { kind: 'integer', bytes: t.length === 1 || t.length === 2 || t.length === 4 ? t.length : 8 }
    case TYPE.BIT:
    case TYPE.BITN:
      return { kind: 'boolean' }
    case TYPE.FLT4:
    case TYPE.FLT8:
    case TYPE.FLTN:
    case TYPE.MONEY:
    case TYPE.MONEY4:
    case TYPE.MONEYN:
    case TYPE.DECIMALN:
    case TYPE.NUMERICN:
    case TYPE.DECIMAL:
    case TYPE.NUMERIC:
      return { kind: 'decimal' }
    case TYPE.DATE:
      return { kind: 'date' }
    case TYPE.TIME:
      return { kind: 'time' }
    case TYPE.DATETIME:
    case TYPE.DATETIM4:
    case TYPE.DATETIMN:
    case TYPE.DATETIME2:
    case TYPE.DATETIMEOFFSET:
      return { kind: 'datetime' }
    case TYPE.GUID:
      return { kind: 'uuid' }
    case TYPE.BIGVARCHAR:
    case TYPE.BIGCHAR:
    case TYPE.TEXT:
      return t.layout === 'ushort' ? { kind: 'string', maxLength: t.length } : { kind: 'string' }
    case TYPE.NVARCHAR:
    case TYPE.NCHAR:
    case TYPE.NTEXT:
      return t.layout === 'ushort' ? { kind: 'string', maxLength: t.length / 2 } : { kind: 'string' }
    case TYPE.BIGVARBINARY:
    case TYPE.BIGBINARY:
    case TYPE.IMAGE:
      return { kind: 'bytes' }
    default:
      // xml, sql_variant, and the CLR types (geography, geometry, hierarchyid): nothing Sosie can fake by type.
      return { kind: 'unknown' }
  }
}

/** A value's text, as the core fakes it; undefined for a type the core fakes as nothing (null). */
export function textOf(t: TypeInfo, b: Buffer): string | undefined {
  switch (t.id) {
    case TYPE.INT1:
      return String(b[0])
    case TYPE.INT2:
    case TYPE.INT4:
    case TYPE.INT8:
    case TYPE.INTN:
      return b.length === 1 ? String(b[0]) : b.length === 2 ? String(b.readInt16LE()) : b.length === 4 ? String(b.readInt32LE()) : String(b.readBigInt64LE())
    case TYPE.BIT:
    case TYPE.BITN:
      return b[0] ? '1' : '0'
    case TYPE.FLT4:
    case TYPE.FLT8:
    case TYPE.FLTN:
      return b.length === 4 ? String(Number(b.readFloatLE().toPrecision(7))) : String(b.readDoubleLE())
    case TYPE.MONEY:
    case TYPE.MONEY4:
    case TYPE.MONEYN:
      return scaled(b.length === 4 ? BigInt(b.readInt32LE()) : (BigInt(b.readInt32LE(0)) << 32n) | BigInt(b.readUInt32LE(4)), 4)
    case TYPE.DECIMALN:
    case TYPE.NUMERICN:
    case TYPE.DECIMAL:
    case TYPE.NUMERIC: {
      let n = 0n
      for (let i = b.length - 1; i >= 1; i--) n = (n << 8n) | BigInt(b[i]!)
      return scaled(b[0] ? n : -n, t.scale ?? 0)
    }
    case TYPE.DATETIME:
    case TYPE.DATETIM4:
    case TYPE.DATETIMN:
      return b.length === 4 ? smallDateTime(b) : dateTime(b)
    case TYPE.DATE:
      return day(b.readUIntLE(0, 3))
    case TYPE.TIME:
      return clock(b, t.scale ?? 7)
    case TYPE.DATETIME2: {
      const n = b.length - 3
      return `${day(b.readUIntLE(n, 3))} ${clock(b.subarray(0, n), t.scale ?? 7)}`
    }
    case TYPE.DATETIMEOFFSET: {
      const n = b.length - 5
      const offset = b.readInt16LE(n + 3)
      const units = BigInt(b.readUIntLE(0, n)) + BigInt(offset) * 60n * 10n ** BigInt(t.scale ?? 7)
      const days = b.readUIntLE(n, 3)
      const perDay = 86_400n * 10n ** BigInt(t.scale ?? 7)
      const total = BigInt(days) * perDay + units
      const local = ((total % perDay) + perDay) % perDay
      return `${day(Number((total - local) / perDay))} ${clockOf(local, t.scale ?? 7)}${zone(offset)}`
    }
    case TYPE.GUID:
      return guid(b)
    case TYPE.BIGVARCHAR:
    case TYPE.BIGCHAR:
    case TYPE.TEXT:
      return decodeText(b, t.collation)
    case TYPE.NVARCHAR:
    case TYPE.NCHAR:
    case TYPE.NTEXT:
      return b.toString('utf16le')
    case TYPE.BIGVARBINARY:
    case TYPE.BIGBINARY:
    case TYPE.IMAGE:
      return `\\x${b.toString('hex')}`
    default:
      return undefined
  }
}

/**
 * A fake's bytes, in the type of the value it stands for: the same length where the type fixes one (char(n), binary(n),
 * a number's), within its range and scale. Undefined where the text is no value of the type.
 */
export function bytesOf(t: TypeInfo, text: string, like?: Buffer): Buffer | undefined {
  switch (t.id) {
    case TYPE.INT1:
    case TYPE.INT2:
    case TYPE.INT4:
    case TYPE.INT8:
    case TYPE.INTN: {
      if (!/^-?\d+$/.test(text)) return undefined
      const size = t.id === TYPE.INTN ? (like?.length ?? t.length) : t.length
      const unsigned = size === 1
      const max = unsigned ? 255n : (1n << BigInt(size * 8 - 1)) - 1n
      const min = unsigned ? 0n : -max - 1n
      const n = clamp(BigInt(text), min, max)
      const out = Buffer.alloc(size)
      if (size === 1) out[0] = Number(n)
      else if (size === 2) out.writeInt16LE(Number(n))
      else if (size === 4) out.writeInt32LE(Number(n))
      else out.writeBigInt64LE(n)
      return out
    }
    case TYPE.BIT:
    case TYPE.BITN:
      return /^(1|true|t)$/i.test(text) ? u8(1) : /^(0|false|f)$/i.test(text) ? u8(0) : undefined
    case TYPE.FLT4:
    case TYPE.FLT8:
    case TYPE.FLTN: {
      const n = Number(text)
      if (!Number.isFinite(n)) return undefined
      const size = t.id === TYPE.FLTN ? (like?.length ?? t.length) : t.length
      const out = Buffer.alloc(size)
      if (size === 4) out.writeFloatLE(n)
      else out.writeDoubleLE(n)
      return out
    }
    case TYPE.MONEY:
    case TYPE.MONEY4:
    case TYPE.MONEYN: {
      const size = t.id === TYPE.MONEYN ? (like?.length ?? t.length) : t.length
      const units = unscaled(text, 4)
      if (units === undefined) return undefined
      if (size === 4) return i32le(Number(clamp(units, -(2n ** 31n), 2n ** 31n - 1n)))
      const n = clamp(units, -(2n ** 63n), 2n ** 63n - 1n)
      const out = Buffer.alloc(8)
      out.writeInt32LE(Number(n >> 32n), 0)
      out.writeUInt32LE(Number(n & 0xffffffffn), 4)
      return out
    }
    case TYPE.DECIMALN:
    case TYPE.NUMERICN:
    case TYPE.DECIMAL:
    case TYPE.NUMERIC: {
      const units = unscaled(text, t.scale ?? 0)
      if (units === undefined) return undefined
      const max = 10n ** BigInt(t.precision ?? 38) - 1n
      const size = like?.length ?? t.length
      let magnitude = clamp(units < 0n ? -units : units, 0n, max)
      const out = Buffer.alloc(size)
      out[0] = units < 0n ? 0 : 1
      for (let i = 1; i < size; i++) {
        out[i] = Number(magnitude & 0xffn)
        magnitude >>= 8n
      }
      return out
    }
    case TYPE.DATETIME:
    case TYPE.DATETIM4:
    case TYPE.DATETIMN: {
      const at = parseDateTime(text)
      if (!at) return undefined
      const size = t.id === TYPE.DATETIMN ? (like?.length ?? t.length) : t.length
      return size === 4 ? smallDateTimeBytes(at) : dateTimeBytes(at)
    }
    case TYPE.DATE: {
      const at = parseDateTime(text)
      return at ? uintle(clampDay(at.day), 3) : undefined
    }
    case TYPE.TIME: {
      const at = parseClock(text, t.scale ?? 7)
      return at === undefined ? undefined : uintle(at, timeBytes(t.scale ?? 7))
    }
    case TYPE.DATETIME2: {
      const at = parseDateTime(text, t.scale ?? 7)
      return at ? Buffer.concat([uintle(at.units, timeBytes(t.scale ?? 7)), uintle(clampDay(at.day), 3)]) : undefined
    }
    case TYPE.DATETIMEOFFSET: {
      const at = parseDateTime(text, t.scale ?? 7)
      if (!at) return undefined
      const scale = t.scale ?? 7
      const perDay = 86_400n * 10n ** BigInt(scale)
      const total = BigInt(clampDay(at.day)) * perDay + BigInt(at.units) - BigInt(at.offset) * 60n * 10n ** BigInt(scale)
      const utc = ((total % perDay) + perDay) % perDay
      const days = Number((total - utc) / perDay)
      const offset = Buffer.alloc(2)
      offset.writeInt16LE(at.offset)
      return Buffer.concat([uintle(Number(utc), timeBytes(scale)), uintle(clampDay(days), 3), offset])
    }
    case TYPE.GUID:
      return guidBytes(text)
    case TYPE.BIGVARCHAR:
    case TYPE.BIGCHAR:
    case TYPE.TEXT:
      return fit(t, encodeText(text, t.collation), like, 0x20)
    case TYPE.NVARCHAR:
    case TYPE.NCHAR:
    case TYPE.NTEXT:
      return fit(t, Buffer.from(text, 'utf16le'), like, 0x20)
    case TYPE.BIGVARBINARY:
    case TYPE.BIGBINARY:
    case TYPE.IMAGE: {
      const hex = text.replace(/^\\x|^0x/i, '')
      if (!/^([0-9a-f]{2})*$/i.test(hex)) return undefined
      return fit(t, Buffer.from(hex, 'hex'), like, 0)
    }
    default:
      return undefined
  }
}

/**
 * Text or bytes within the type's length: a fixed type's (char(n), binary(n)) padded to the length the real value had,
 * a variable one's cut at its maximum. A cut never splits a UTF-16 character.
 */
function fit(t: TypeInfo, b: Buffer, like: Buffer | undefined, pad: number): Buffer {
  const unicode = UNICODE.has(t.id)
  const fixed = t.id === TYPE.BIGCHAR || t.id === TYPE.NCHAR || t.id === TYPE.BIGBINARY
  if (t.layout === 'ushort' && b.length > t.length) b = b.subarray(0, unicode ? t.length & ~1 : t.length)
  if (unicode && b.length >= 2) {
    const last = b.readUInt16LE(b.length - 2)
    if (last >= 0xd800 && last <= 0xdbff) b = b.subarray(0, b.length - 2)
  }
  if (fixed) {
    const length = like?.length ?? t.length
    if (b.length < length) {
      const filler = unicode ? Buffer.from(' '.repeat((length - b.length) / 2), 'utf16le') : Buffer.alloc(length - b.length, pad)
      b = Buffer.concat([b, filler])
    }
    b = b.subarray(0, length)
  }
  return b
}

function clamp(n: bigint, min: bigint, max: bigint): bigint {
  return n < min ? min : n > max ? max : n
}

function i32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}

function uintle(n: number, size: number): Buffer {
  const b = Buffer.alloc(size)
  b.writeUIntLE(n, 0, size)
  return b
}

/** A number's text with `scale` digits after the point: 512.8700. */
function scaled(n: bigint, scale: number): string {
  const negative = n < 0n
  const digits = (negative ? -n : n).toString().padStart(scale + 1, '0')
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  return negative ? `-${text}` : text
}

/** A number's text as a whole number of units of 10^-scale, rounded; undefined for anything but a number. */
function unscaled(text: string, scale: number): bigint | undefined {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim())
  if (!m || (!m[2] && !m[3])) return undefined
  const fraction = (m[3] ?? '').padEnd(scale + 1, '0')
  let units = BigInt((m[2] || '0') + fraction.slice(0, scale))
  if (Number(fraction[scale]) >= 5) units += 1n
  return m[1] === '-' ? -units : units
}

/* Dates and times: days from 0001-01-01 (date, datetime2, datetimeoffset) or 1900-01-01 (datetime). */

const DAY_MS = 86_400_000
/** Date.UTC reads a year under 100 as 1900 and more: the year is set on its own. */
const utcDay = (year: number, month: number, date: number) => new Date(0).setUTCFullYear(year, month - 1, date)
const EPOCH_0001 = utcDay(1, 1, 1)
const EPOCH_1900 = Date.UTC(1900, 0, 1)
const LAST_DAY = 3_652_058

function clampDay(day: number): number {
  return Math.min(Math.max(day, 0), LAST_DAY)
}

function pad(n: number | bigint, width = 2): string {
  return String(n).padStart(width, '0')
}

/** A date's text from its days since 0001-01-01. */
function day(days: number): string {
  const d = new Date(EPOCH_0001 + days * DAY_MS)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function dayOf(year: number, month: number, date: number): number {
  return Math.round((utcDay(year, month, date) - EPOCH_0001) / DAY_MS)
}

/** A time's text from its units of 10^-scale seconds since midnight. */
function clock(b: Buffer, scale: number): string {
  return clockOf(BigInt(b.readUIntLE(0, b.length)), scale)
}

function clockOf(units: bigint, scale: number): string {
  const per = 10n ** BigInt(scale)
  const seconds = units / per
  const fraction = scale ? `.${pad(units % per, scale)}` : ''
  return `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}${fraction}`
}

function zone(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const m = Math.abs(minutes)
  return `${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

function dateTime(b: Buffer): string {
  const days = b.readInt32LE(0)
  const ticks = b.readUInt32LE(4)
  const ms = Math.round((ticks * 10) / 3)
  const d = new Date(EPOCH_1900 + days * DAY_MS + ms)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

function smallDateTime(b: Buffer): string {
  const d = new Date(EPOCH_1900 + b.readUInt16LE(0) * DAY_MS + b.readUInt16LE(2) * 60_000)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`
}

interface Moment {
  /** Days since 0001-01-01. */
  day: number
  /** Units of 10^-scale seconds since midnight. */
  units: number
  /** Minutes east of UTC. */
  offset: number
}

const DATETIME_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/

function parseDateTime(text: string, scale = 7): Moment | undefined {
  const m = DATETIME_TEXT.exec(text.trim())
  if (!m) return undefined
  const fraction = (m[7] ?? '').padEnd(scale, '0').slice(0, scale)
  const seconds = Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)
  const offset = !m[8] || m[8] === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2)))
  return { day: dayOf(Number(m[1]), Number(m[2]), Number(m[3])), units: seconds * 10 ** scale + Number(fraction || 0), offset }
}

function parseClock(text: string, scale: number): number | undefined {
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(text.trim())
  if (!m) return undefined
  const fraction = (m[4] ?? '').padEnd(scale, '0').slice(0, scale)
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) % 86_400) * 10 ** scale + Number(fraction || 0)
}

function dateTimeBytes(at: Moment): Buffer {
  const ms = (at.units / 1e7) * 1000
  const days = Math.min(Math.max(at.day - Math.round((EPOCH_1900 - EPOCH_0001) / DAY_MS), -53_690), 2_958_463)
  const out = Buffer.alloc(8)
  out.writeInt32LE(days, 0)
  out.writeUInt32LE(Math.min(Math.round((ms * 3) / 10), 25_919_999), 4)
  return out
}

function smallDateTimeBytes(at: Moment): Buffer {
  const days = Math.min(Math.max(at.day - Math.round((EPOCH_1900 - EPOCH_0001) / DAY_MS), 0), 65_535)
  const out = Buffer.alloc(4)
  out.writeUInt16LE(days, 0)
  out.writeUInt16LE(Math.min(Math.floor(at.units / 1e7 / 60), 1439), 2)
  return out
}

/** A uniqueidentifier's text: its first three groups little-endian, as SQL Server shows it. */
function guid(b: Buffer): string {
  const hex = (from: number, to: number, reverse = false) => {
    const part = Buffer.from(b.subarray(from, to))
    return (reverse ? part.reverse() : part).toString('hex')
  }
  return `${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10)}-${hex(10, 16)}`.toUpperCase()
}

function guidBytes(text: string): Buffer | undefined {
  const m = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(text.trim())
  if (!m) return undefined
  const le = (hex: string) => Buffer.from(hex, 'hex').reverse()
  return Buffer.concat([le(m[1]!), le(m[2]!), le(m[3]!), Buffer.from(m[4]! + m[5]!, 'hex')])
}

/* Collations: what code page a char or varchar column's bytes are in. */

/** A collation's code page: UTF-8 for a _UTF8 collation; a SQL collation's by its sort order; a Windows one's by its language. */
export function codePage(collation: Buffer | undefined): string {
  if (!collation || collation.length < 5) return 'windows-1252'
  const info = collation.readUInt32LE(0)
  if (info & (1 << 26)) return 'utf-8'
  const sortId = collation[4]!
  if (sortId) return SORT_PAGES.find(([from, to]) => sortId >= from && sortId <= to)?.[2] ?? 'windows-1252'
  const lcid = info & 0xfffff
  return LCID_PAGES[lcid] ?? LANGUAGE_PAGES[lcid & 0x3ff] ?? 'windows-1252'
}

/** SQL collations' sort orders, by range, to their code page (sys.fn_helpcollations). */
const SORT_PAGES: [number, number, string][] = [
  [30, 34, 'ibm437'],
  [40, 49, 'ibm850'],
  [50, 61, 'windows-1252'],
  [71, 75, 'windows-1252'],
  [80, 96, 'windows-1250'],
  [104, 108, 'windows-1251'],
  [112, 114, 'windows-1253'],
  [120, 124, 'windows-1253'],
  [128, 130, 'windows-1254'],
  [136, 138, 'windows-1255'],
  [144, 146, 'windows-1256'],
  [152, 160, 'windows-1257'],
  [183, 186, 'windows-1252'],
  [192, 199, 'windows-1250'],
  [200, 209, 'windows-1251'],
  [210, 215, 'windows-1253'],
]

/** Windows collations' languages whose code page is not their language's alone. */
const LCID_PAGES: Record<number, string> = { 0x0804: 'gbk', 0x1004: 'gbk', 0x0404: 'big5', 0x0c04: 'big5', 0x1404: 'big5' }

/** Windows collations' languages (an LCID's low ten bits) to their code page; any other is 1252. */
const LANGUAGE_PAGES: Record<number, string> = {
  0x05: 'windows-1250', 0x0e: 'windows-1250', 0x15: 'windows-1250', 0x18: 'windows-1250', 0x1a: 'windows-1250',
  0x1b: 'windows-1250', 0x1c: 'windows-1250', 0x24: 'windows-1250',
  0x02: 'windows-1251', 0x19: 'windows-1251', 0x22: 'windows-1251', 0x23: 'windows-1251', 0x2f: 'windows-1251',
  0x3f: 'windows-1251', 0x40: 'windows-1251', 0x44: 'windows-1251', 0x50: 'windows-1251',
  0x08: 'windows-1253', 0x1f: 'windows-1254', 0x2c: 'windows-1254', 0x0d: 'windows-1255',
  0x01: 'windows-1256', 0x20: 'windows-1256', 0x29: 'windows-1256', 0x8c: 'windows-1256',
  0x25: 'windows-1257', 0x26: 'windows-1257', 0x27: 'windows-1257', 0x2a: 'windows-1258', 0x1e: 'windows-874',
  0x11: 'shift_jis', 0x12: 'euc-kr', 0x04: 'gbk',
}

const decoders = new Map<string, TextDecoder>()

function decoder(page: string): TextDecoder {
  let d = decoders.get(page)
  if (!d) {
    try {
      d = new TextDecoder(page)
    } catch {
      // A code page Node does not read (437, 850): its bytes as Latin-1.
      d = new TextDecoder('latin1')
    }
    decoders.set(page, d)
  }
  return d
}

/** A char or varchar value's text, from its collation's code page. */
export function decodeText(b: Buffer, collation: Buffer | undefined): string {
  return decoder(codePage(collation)).decode(b)
}

const encoders = new Map<string, Map<string, number[]>>()

/** Each character a code page has, to its bytes: read from the page's decoder, one byte or two. */
function encoderFor(page: string): Map<string, number[]> {
  let map = encoders.get(page)
  if (map) return map
  map = new Map()
  const d = decoder(page)
  for (let b = 0; b < 256; b++) {
    const ch = d.decode(Uint8Array.of(b))
    if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [b])
  }
  if (['shift_jis', 'gbk', 'big5', 'euc-kr'].includes(page)) {
    for (let lead = 0x81; lead < 0xff; lead++) {
      for (let trail = 0x40; trail < 0xff; trail++) {
        const ch = d.decode(Uint8Array.of(lead, trail))
        if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [lead, trail])
      }
    }
  }
  encoders.set(page, map)
  return map
}

/** A fake's bytes in its column's code page: a character the page has none for is ?, as SQL Server writes it. */
export function encodeText(text: string, collation: Buffer | undefined): Buffer {
  const page = codePage(collation)
  if (page === 'utf-8') return Buffer.from(text, 'utf8')
  if (/^[\x00-\x7f]*$/.test(text)) return Buffer.from(text, 'latin1')
  const map = encoderFor(page)
  const out: number[] = []
  for (const ch of text) out.push(...(map.get(ch) ?? [0x3f]))
  return Buffer.from(out)
}
