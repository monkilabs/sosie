import { parseArray, serializeArray } from './arrays.js'

/**
 * Postgres's binary format, for the types Sosie can write from their text. Sosie reads every value upstream as
 * text, since that is what it fakes; a client that asks for a column in binary (asyncpg, pgx, JDBC once a statement
 * is prepared) gets the faked text encoded, and a parameter it sends in binary is read back to text, so a fake in it
 * turns back like one sent as text. A type is known by its send function, as pg_type names it: a domain sends as its
 * base type does, an enum as its label, an array as array_send with its element's codec.
 */

/** How a type is sent, from pg_type: its send function, its element type (arrays), its base type (domains). */
export interface TypeSend {
  name: string
  send: string
  elem: number
  base: number
}

export interface Codec {
  /** The value's binary form, from its text as Postgres writes it; throws on text it cannot read. */
  encode(text: string): Buffer
  /** The value's text, as Postgres writes it, from its binary form. */
  decode(bytes: Buffer): string
}

/** A type's codec; undefined when Sosie cannot write that type in binary. */
export function codecFor(oid: number, sends: Map<number, TypeSend>, depth = 0): Codec | undefined {
  const type = sends.get(oid)
  if (!type || depth > 8) return undefined
  if (type.send === 'array_send') {
    // A domain over an array names no element of its own: its base type does.
    const elemOid = type.elem || (type.base ? arrayElement(type.base, sends) : 0)
    const element = elemOid ? codecFor(elemOid, sends, depth + 1) : undefined
    return element && arrayCodec(elemOid, element)
  }
  if (type.send === 'int2vectorsend') return vectorCodec(21, int(2))
  if (type.send === 'oidvectorsend') return vectorCodec(26, uint32)
  return SCALARS[type.send]
}

function arrayElement(oid: number, sends: Map<number, TypeSend>): number {
  for (let type = sends.get(oid), depth = 0; type && depth < 8; type = sends.get(type.base), depth++) {
    if (type.elem && type.send === 'array_send') return type.elem
    if (!type.base) return 0
  }
  return 0
}

/* Scalars. */

const fail = (what: string, text: string): never => {
  throw new Error(`Not ${what}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`)
}

const text: Codec = { encode: (t) => Buffer.from(t, 'utf8'), decode: (b) => b.toString('utf8') }

const bool: Codec = {
  encode: (t) => (t === 't' || t === 'f' ? Buffer.from([t === 't' ? 1 : 0]) : fail('a boolean', t)),
  decode: (b) => (b[0] ? 't' : 'f'),
}

const bytea: Codec = {
  encode: (t) => (/^\\x(?:[0-9a-fA-F]{2})*$/.test(t) ? Buffer.from(t.slice(2), 'hex') : fail('bytea in hex', t)),
  decode: (b) => `\\x${b.toString('hex')}`,
}

/** "char": one byte; Postgres writes 0 as '' and a byte with the high bit set as \ooo. */
const char: Codec = {
  encode(t) {
    if (t === '') return Buffer.from([0])
    if (/^\\[0-3][0-7]{2}$/.test(t)) return Buffer.from([parseInt(t.slice(1), 8)])
    return t.length === 1 && t.charCodeAt(0) < 128 ? Buffer.from([t.charCodeAt(0)]) : fail('a "char"', t)
  },
  decode: (b) => (b[0] === 0 ? '' : b[0]! >= 128 ? `\\${b[0]!.toString(8).padStart(3, '0')}` : String.fromCharCode(b[0]!)),
}

function int(bytes: 2 | 4 | 8): Codec {
  return {
    encode(t) {
      if (!/^-?\d+$/.test(t)) fail('an integer', t)
      const b = Buffer.alloc(bytes)
      if (bytes === 2) b.writeInt16BE(Number(t))
      else if (bytes === 4) b.writeInt32BE(Number(t))
      else b.writeBigInt64BE(BigInt(t))
      return b
    },
    decode: (b) => (bytes === 2 ? String(b.readInt16BE()) : bytes === 4 ? String(b.readInt32BE()) : String(b.readBigInt64BE())),
  }
}

const uint32: Codec = {
  encode(t) {
    if (!/^\d+$/.test(t)) fail('an unsigned integer', t)
    const b = Buffer.alloc(4)
    b.writeUInt32BE(Number(t))
    return b
  },
  decode: (b) => String(b.readUInt32BE()),
}

const uint64: Codec = {
  encode(t) {
    if (!/^\d+$/.test(t)) fail('an unsigned integer', t)
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(t))
    return b
  },
  decode: (b) => String(b.readBigUInt64BE()),
}

const FLOAT = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|-?Infinity|NaN)$/i

function float(bytes: 4 | 8): Codec {
  return {
    encode(t) {
      if (!FLOAT.test(t)) fail('a float', t)
      const b = Buffer.alloc(bytes)
      if (bytes === 4) b.writeFloatBE(Number(t))
      else b.writeDoubleBE(Number(t))
      return b
    },
    decode(b) {
      const n = bytes === 4 ? b.readFloatBE() : b.readDoubleBE()
      if (Object.is(n, -0)) return '-0'
      if (bytes === 8 || !Number.isFinite(n)) return String(n)
      // The shortest text that reads back as the same float4, as Postgres writes one.
      for (let digits = 1; digits < 9; digits++) {
        const shorter = Number(n.toPrecision(digits))
        if (Math.fround(shorter) === n) return String(shorter)
      }
      return String(n)
    },
  }
}

/** numeric: base-10000 digits, a weight, a sign and a display scale. */
const NUMERIC_NEG = 0x4000
const NUMERIC_NAN = 0xc000
const NUMERIC_PINF = 0xd000
const NUMERIC_NINF = 0xf000

const numeric: Codec = {
  encode(t) {
    const special = t === 'NaN' ? NUMERIC_NAN : t === 'Infinity' ? NUMERIC_PINF : t === '-Infinity' ? NUMERIC_NINF : undefined
    // Postgres sends a display scale of 32 with either infinity, read from bits of its special header.
    if (special !== undefined) return numericHeader(0, 0, special, special === NUMERIC_NAN ? 0 : 32, [])
    const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(t)
    if (!m || (!m[2] && !m[3])) fail('a numeric', t)
    const whole = m![2]!.replace(/^0+/, '')
    const fraction = m![3] ?? ''
    const left = whole.padStart(Math.ceil(whole.length / 4) * 4, '0')
    const right = fraction.padEnd(Math.ceil(fraction.length / 4) * 4, '0')
    const digits = `${left}${right}`.match(/.{4}/g)?.map(Number) ?? []
    let weight = left.length / 4 - 1
    while (digits.length && digits[0] === 0) {
      digits.shift()
      weight--
    }
    while (digits.length && digits.at(-1) === 0) digits.pop()
    if (!digits.length) weight = 0
    return numericHeader(digits.length, weight, m![1] === '-' && digits.length ? NUMERIC_NEG : 0, fraction.length, digits)
  },
  decode(b) {
    const ndigits = b.readInt16BE(0)
    const weight = b.readInt16BE(2)
    const sign = b.readUInt16BE(4)
    const dscale = b.readInt16BE(6)
    if (sign === NUMERIC_NAN) return 'NaN'
    if (sign === NUMERIC_PINF) return 'Infinity'
    if (sign === NUMERIC_NINF) return '-Infinity'
    const digit = (i: number) => (i >= 0 && i < ndigits ? b.readInt16BE(8 + 2 * i) : 0)
    let whole = ''
    for (let i = 0; i <= weight; i++) whole += i === 0 ? String(digit(0)) : String(digit(i)).padStart(4, '0')
    let fraction = ''
    for (let i = weight + 1; fraction.length < dscale; i++) fraction += String(digit(i)).padStart(4, '0')
    const value = `${whole || '0'}${dscale ? `.${fraction.slice(0, dscale)}` : ''}`
    return sign === NUMERIC_NEG ? `-${value}` : value
  },
}

function numericHeader(ndigits: number, weight: number, sign: number, dscale: number, digits: number[]): Buffer {
  const b = Buffer.alloc(8 + 2 * ndigits)
  b.writeInt16BE(ndigits, 0)
  b.writeInt16BE(weight, 2)
  b.writeUInt16BE(sign, 4)
  b.writeInt16BE(dscale, 6)
  digits.forEach((d, i) => b.writeInt16BE(d, 8 + 2 * i))
  return b
}

/* Dates and times: days and microseconds since 2000-01-01, as Postgres counts them. */

const MICROS_PER_DAY = 86_400_000_000n
const INT64_MAX = 0x7fffffffffffffffn
const INT64_MIN = -0x8000000000000000n
const EPOCH = daysFromCivil(2000, 1, 1)

/** Days since 1970-01-01 of a date in the proleptic Gregorian calendar, any year. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp + (mp < 10 ? 3 : -9)
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day]
}

const pad = (n: number | bigint, width = 2) => String(n).padStart(width, '0')

/** Postgres's dates: a year of at least four digits, BC after the rest. */
function dayOf(date: string, bc: boolean): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return daysFromCivil(bc ? 1 - y : y, m, d) - EPOCH
}

function dateText(days: number): [string, boolean] {
  const [y, m, d] = civilFromDays(days + EPOCH)
  return [`${pad(y > 0 ? y : 1 - y, 4)}-${pad(m)}-${pad(d)}`, y <= 0]
}

/** Microseconds of a time of day, from HH:MM:SS and an optional fraction. */
function microsOf(h: string, m: string, s: string, fraction = ''): bigint {
  return (BigInt(h) * 3600n + BigInt(m) * 60n + BigInt(s)) * 1_000_000n + BigInt(fraction.slice(1, 7).padEnd(6, '0') || '0')
}

function timeText(micros: bigint): string {
  const seconds = micros / 1_000_000n
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}${fraction ? `.${fraction}` : ''}`
}

/** An offset as Postgres writes it: +HH, then :MM and :SS when not zero. */
function offsetSeconds(sign: string, h: string, m = '0', s = '0'): number {
  return (sign === '-' ? -1 : 1) * (Number(h) * 3600 + Number(m) * 60 + Number(s))
}

function offsetText(seconds: number): string {
  const abs = Math.abs(seconds)
  const [h, m, s] = [Math.floor(abs / 3600), Math.floor(abs / 60) % 60, abs % 60]
  return `${seconds < 0 ? '-' : '+'}${pad(h)}${m || s ? `:${pad(m)}` : ''}${s ? `:${pad(s)}` : ''}`
}

const DATE = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/

const date: Codec = {
  encode(t) {
    const b = Buffer.alloc(4)
    if (t === 'infinity' || t === '-infinity') b.writeInt32BE(t === 'infinity' ? 0x7fffffff : -0x80000000)
    else {
      const m = DATE.exec(t) ?? fail('a date', t)
      b.writeInt32BE(dayOf(`${m[1]}-${m[2]}-${m[3]}`, !!m[4]))
    }
    return b
  },
  decode(b) {
    const days = b.readInt32BE()
    if (days === 0x7fffffff) return 'infinity'
    if (days === -0x80000000) return '-infinity'
    const [text, bc] = dateText(days)
    return bc ? `${text} BC` : text
  },
}

const TIMESTAMP = /^(\d{4,}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?)?( BC)?$/

function timestamp(zoned: boolean): Codec {
  return {
    encode(t) {
      const b = Buffer.alloc(8)
      if (t === 'infinity' || t === '-infinity') {
        b.writeBigInt64BE(t === 'infinity' ? INT64_MAX : INT64_MIN)
        return b
      }
      const m = TIMESTAMP.exec(t) ?? fail('a timestamp', t)
      if (zoned !== (m[6] !== undefined)) fail(zoned ? 'a timestamp with a time zone' : 'a timestamp', t)
      let micros = BigInt(dayOf(m[1]!, !!m[10])) * MICROS_PER_DAY + microsOf(m[2]!, m[3]!, m[4]!, m[5])
      if (zoned) micros -= BigInt(offsetSeconds(m[6]!, m[7]!, m[8], m[9])) * 1_000_000n
      b.writeBigInt64BE(micros)
      return b
    },
    decode(b) {
      const micros = b.readBigInt64BE()
      if (micros === INT64_MAX) return 'infinity'
      if (micros === INT64_MIN) return '-infinity'
      let days = micros / MICROS_PER_DAY
      let rest = micros % MICROS_PER_DAY
      if (rest < 0n) {
        days -= 1n
        rest += MICROS_PER_DAY
      }
      const [day, bc] = dateText(Number(days))
      // A zoned value goes back in UTC: the same instant, whatever the session's time zone.
      return `${day} ${timeText(rest)}${zoned ? '+00' : ''}${bc ? ' BC' : ''}`
    },
  }
}

const TIME = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/
const TIMETZ = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/

const time: Codec = {
  encode(t) {
    const m = TIME.exec(t) ?? fail('a time', t)
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(microsOf(m[1]!, m[2]!, m[3]!, m[4]))
    return b
  },
  decode: (b) => timeText(b.readBigInt64BE()),
}

/** timetz: the time, then the zone as seconds west of UTC. */
const timetz: Codec = {
  encode(t) {
    const m = TIMETZ.exec(t) ?? fail('a time with a time zone', t)
    const b = Buffer.alloc(12)
    b.writeBigInt64BE(microsOf(m[1]!, m[2]!, m[3]!, m[4]))
    b.writeInt32BE(-offsetSeconds(m[5]!, m[6]!, m[7], m[8]), 8)
    return b
  },
  decode: (b) => `${timeText(b.readBigInt64BE())}${offsetText(-b.readInt32BE(8))}`,
}

/** interval, as IntervalStyle postgres writes it: microseconds of time, then days, then months. */
const INTERVAL_PART = /^([+-]?\d+) (year|mon|day)s?$/
const INTERVAL_TIME = /^([+-])?(\d+):(\d{2}):(\d{2})(\.\d+)?$/

const interval: Codec = {
  encode(t) {
    let months = 0
    let days = 0
    let micros = 0n
    const words = t.split(' ')
    for (let i = 0; i < words.length; i++) {
      const time = INTERVAL_TIME.exec(words[i]!)
      if (time) {
        const value = microsOf(time[2]!, time[3]!, time[4]!, time[5])
        micros += time[1] === '-' ? -value : value
        continue
      }
      const part = INTERVAL_PART.exec(`${words[i]} ${words[i + 1] ?? ''}`) ?? fail('an interval', t)
      i++
      const n = Number(part[1])
      if (part[2] === 'year') months += 12 * n
      else if (part[2] === 'mon') months += n
      else days += n
    }
    const b = Buffer.alloc(16)
    b.writeBigInt64BE(micros)
    b.writeInt32BE(days, 8)
    b.writeInt32BE(months, 12)
    return b
  },
  decode(b) {
    const micros = b.readBigInt64BE()
    const days = b.readInt32BE(8)
    const months = b.readInt32BE(12)
    // As Postgres's EncodeInterval writes INTSTYLE_POSTGRES.
    const parts: string[] = []
    let before = false
    const add = (value: number, unit: string) => {
      if (!value) return
      parts.push(`${before && value > 0 ? '+' : ''}${value} ${unit}${value !== 1 ? 's' : ''}`)
      before = value < 0
    }
    add(Math.trunc(months / 12), 'year')
    add(months % 12, 'mon')
    add(days, 'day')
    if (!parts.length || micros !== 0n) {
      const minus = micros < 0n
      parts.push(`${minus ? '-' : before ? '+' : ''}${timeText(minus ? -micros : micros)}`)
    }
    return parts.join(' ')
  },
}

const uuid: Codec = {
  encode: (t) =>
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(t) ? Buffer.from(t.replace(/-/g, ''), 'hex') : fail('a uuid', t),
  decode(b) {
    const h = b.toString('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  },
}

/** bit and varbit: the number of bits, then the bits, eight to a byte, the first the highest. */
const bits: Codec = {
  encode(t) {
    if (!/^[01]*$/.test(t)) fail('bits', t)
    const out = Buffer.alloc(4 + Math.ceil(t.length / 8))
    out.writeInt32BE(t.length, 0)
    for (let i = 0; i < t.length; i++) if (t[i] === '1') out[4 + (i >> 3)]! |= 0x80 >> (i & 7)
    return out
  },
  decode(b) {
    if (b.length < 4) fail('bits', b.toString('hex'))
    const n = b.readInt32BE(0)
    if (n < 0 || Math.ceil(n / 8) !== b.length - 4) fail('bits', b.toString('hex'))
    let text = ''
    for (let i = 0; i < n; i++) text += b[4 + (i >> 3)]! & (0x80 >> (i & 7)) ? '1' : '0'
    return text
  },
}

/** jsonb: a version byte, then its text. */
const jsonb: Codec = {
  encode: (t) => Buffer.concat([Buffer.from([1]), Buffer.from(t, 'utf8')]),
  decode: (b) => (b[0] === 1 ? b.subarray(1).toString('utf8') : fail('jsonb of version 1', b.toString('hex'))),
}

/** inet and cidr: Postgres's own family codes (AF_INET, AF_INET + 1), the mask's bits, cidr or not, the address. */
const PGSQL_AF_INET = 2
const PGSQL_AF_INET6 = 3

function network(cidr: boolean): Codec {
  return {
    encode(t) {
      const [address = '', bits] = t.split('/')
      const bytes = address.includes(':') ? ipv6(address) : ipv4(address)
      if (!bytes || (bits !== undefined && !/^\d+$/.test(bits))) fail(cidr ? 'a cidr' : 'an inet', t)
      const max = bytes!.length * 8
      return Buffer.from([bytes!.length === 4 ? PGSQL_AF_INET : PGSQL_AF_INET6, bits === undefined ? max : Number(bits), cidr ? 1 : 0, bytes!.length, ...bytes!])
    },
    decode(b) {
      const bits = b[1]!
      const address = b.subarray(4, 4 + b[3]!)
      const text = address.length === 4 ? [...address].join('.') : ipv6Text(address)
      return cidr || bits !== address.length * 8 ? `${text}/${bits}` : text
    },
  }
}

function ipv4(text: string): number[] | undefined {
  const parts = text.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) < 256)) return undefined
  return parts.map(Number)
}

function ipv6(text: string): number[] | undefined {
  let tail: number[] = []
  let rest = text
  // An IPv4 address in the last 32 bits (::ffff:1.2.3.4).
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const v4 = ipv4(dotted[2]!)
    if (!v4) return undefined
    tail = v4
    rest = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1)
  }
  const halves = rest.split('::')
  if (halves.length > 2) return undefined
  const groups = (s: string) => (s ? s.split(':') : [])
  const head = groups(halves[0]!)
  const back = halves.length === 2 ? groups(halves[1]!) : []
  const width = 8 - tail.length / 2
  const missing = width - head.length - back.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined
  const words = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...back]
  if (!words.every((w) => /^[0-9a-f]{1,4}$/i.test(w))) return undefined
  return [...words.flatMap((w) => [parseInt(w, 16) >> 8, parseInt(w, 16) & 0xff]), ...tail]
}

/** An IPv6 address as Postgres writes it: the longest run of two or more zero words as ::, an IPv4 tail dotted. */
function ipv6Text(bytes: Buffer): string {
  const words = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(2 * i))
  let best = { base: -1, len: 0 }
  for (let i = 0, cur = { base: -1, len: 0 }; i < 8; i++) {
    if (words[i] === 0) {
      cur = cur.base === -1 ? { base: i, len: 1 } : { base: cur.base, len: cur.len + 1 }
      if (cur.len > best.len) best = cur
    } else cur = { base: -1, len: 0 }
  }
  if (best.len < 2) best = { base: -1, len: 0 }
  const v4tail = best.base === 0 && (best.len === 6 || (best.len === 5 && words[5] === 0xffff))
  let out = ''
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ':'
      continue
    }
    if (i) out += ':'
    if (i === 6 && v4tail) {
      out += [...bytes.subarray(12)].join('.')
      break
    }
    out += words[i]!.toString(16)
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ':'
  return out
}

const pgLsn: Codec = {
  encode(t) {
    const m = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(t) ?? fail('an LSN', t)
    const b = Buffer.alloc(8)
    b.writeUInt32BE(parseInt(m[1]!, 16))
    b.writeUInt32BE(parseInt(m[2]!, 16), 4)
    return b
  },
  decode: (b) => `${b.readUInt32BE().toString(16).toUpperCase()}/${b.readUInt32BE(4).toString(16).toUpperCase()}`,
}

const empty: Codec = { encode: (t) => (t === '' ? Buffer.alloc(0) : fail('void', t)), decode: () => '' }

const SCALARS: Record<string, Codec> = {
  textsend: text,
  varcharsend: text,
  bpcharsend: text,
  namesend: text,
  unknownsend: text,
  enum_send: text,
  json_send: text,
  citextsend: text,
  jsonb_send: jsonb,
  boolsend: bool,
  byteasend: bytea,
  charsend: char,
  int2send: int(2),
  int4send: int(4),
  int8send: int(8),
  oidsend: uint32,
  xidsend: uint32,
  cidsend: uint32,
  xid8send: uint64,
  float4send: float(4),
  float8send: float(8),
  numeric_send: numeric,
  date_send: date,
  time_send: time,
  timetz_send: timetz,
  timestamp_send: timestamp(false),
  timestamptz_send: timestamp(true),
  interval_send: interval,
  uuid_send: uuid,
  bit_send: bits,
  varbit_send: bits,
  inet_send: network(false),
  cidr_send: network(true),
  pg_lsn_send: pgLsn,
  void_send: empty,
}

/* Arrays: dimensions, a flag for nulls, the element type, each dimension's length and lower bound, then each element. */

type Nested = (string | null | Nested)[]

/** Postgres's MAXDIM. */
const MAX_DIMENSIONS = 6

function arrayCodec(elemOid: number, element: Codec): Codec {
  return {
    encode(t) {
      const { bounds, items } = parseArray(t)
      const dims: number[] = []
      for (let level: unknown = items; Array.isArray(level); level = level[0]) {
        dims.push(level.length)
        if (!level.length) break
      }
      const flat: (string | null)[] = []
      const walk = (level: Nested) => level.forEach((v) => (Array.isArray(v) ? walk(v) : flat.push(v)))
      walk(items as Nested)
      // '{}' has no dimensions at all.
      const empty = flat.length === 0
      const lower = bounds ? [...bounds.matchAll(/\[(-?\d+):-?\d+\]/g)].map((m) => Number(m[1])) : []
      const header = Buffer.alloc(12 + (empty ? 0 : 8 * dims.length))
      header.writeInt32BE(empty ? 0 : dims.length, 0)
      header.writeInt32BE(flat.includes(null) ? 1 : 0, 4)
      header.writeUInt32BE(elemOid, 8)
      if (!empty) dims.forEach((d, i) => (header.writeInt32BE(d, 12 + 8 * i), header.writeInt32BE(lower[i] ?? 1, 16 + 8 * i)))
      return Buffer.concat([header, ...flat.map((v) => lengthPrefixed(v === null ? null : element.encode(v)))])
    },
    decode(b) {
      const ndim = b.readInt32BE(0)
      if (ndim === 0) return '{}'
      // Checked as Postgres's array_recv checks it, before anything is built: a client's dimensions could ask for
      // billions of empty arrays and no element at all.
      if (ndim < 0 || ndim > MAX_DIMENSIONS) throw new Error(`An array of ${ndim} dimensions.`)
      const dims = Array.from({ length: ndim }, (_, i) => [b.readInt32BE(12 + 8 * i), b.readInt32BE(16 + 8 * i)] as const)
      let at = 12 + 8 * ndim
      if (dims.some(([length]) => length < 0)) throw new Error('An array with a negative dimension.')
      // A dimension of 0 makes the array empty, as Postgres reads it.
      if (dims.some(([length]) => length === 0)) return '{}'
      let count = 1
      for (const [length] of dims) {
        count *= length
        // Each element takes 4 bytes at least, its length: more than the message holds is a lie.
        if (count > (b.length - at) / 4) throw new Error('An array with more elements than the message holds.')
      }
      const next = (): string | null => {
        const length = b.readInt32BE(at)
        at += 4
        if (length < 0) return null
        at += length
        return element.decode(b.subarray(at - length, at))
      }
      const build = (level: number): Nested => Array.from({ length: dims[level]![0] }, () => (level + 1 < ndim ? build(level + 1) : next()))
      const bounds = dims.some(([, lb]) => lb !== 1) ? `${dims.map(([len, lb]) => `[${lb}:${lb + len - 1}]`).join('')}=` : ''
      return serializeArray(build(0), bounds)
    },
  }
}

/** int2vector and oidvector: space-separated text, sent as a one-dimensional array that starts at 0. */
function vectorCodec(elemOid: number, element: Codec): Codec {
  return {
    encode(t) {
      const items = t ? t.split(' ') : []
      const header = Buffer.alloc(20)
      header.writeInt32BE(1, 0)
      header.writeInt32BE(0, 4)
      header.writeUInt32BE(elemOid, 8)
      header.writeInt32BE(items.length, 12)
      header.writeInt32BE(0, 16)
      return Buffer.concat([header, ...items.map((v) => lengthPrefixed(element.encode(v)))])
    },
    decode(b) {
      const ndim = b.readInt32BE(0)
      const count = ndim ? b.readInt32BE(12) : 0
      const items: string[] = []
      for (let i = 0, at = 12 + 8 * ndim; i < count; i++) {
        const length = b.readInt32BE(at)
        items.push(element.decode(b.subarray(at + 4, at + 4 + length)))
        at += 4 + length
      }
      return items.join(' ')
    },
  }
}

function lengthPrefixed(value: Buffer | null): Buffer {
  const length = Buffer.alloc(4)
  length.writeInt32BE(value === null ? -1 : value.length)
  return value === null ? length : Buffer.concat([length, value])
}
