import type { Faker as FakerJs } from '@faker-js/faker'
import type { FieldType } from '../source.js'
import { generate, text, type Format } from './formats.js'
import { matchCase, shape, type Random } from './random.js'

/** Types whose fakes are drawn and stored; booleans, enums, json and arrays are handled around them. */
export type ScalarKind = 'string' | 'integer' | 'decimal' | 'uuid' | 'date' | 'datetime' | 'time' | 'ip' | 'bytes'

export interface Draw {
  random: Random
  faker: FakerJs
  /** 0 on the first draw; higher when the previous fake was taken. */
  attempt: number
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const DATE = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/
const DATETIME = /^(\d{4,})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2}){0,2})?( BC)?$/
const TIME = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-]\d{2}(?::?\d{2}){0,2})?$/

/** The fake of one scalar value of a type, as text. */
export function fakeScalar(
  real: string,
  type: FieldType & { kind: ScalarKind },
  format: Format | undefined,
  draw: Draw,
): string {
  switch (type.kind) {
    case 'string': {
      const fake = format ? generate(format, real, draw.faker, draw.random) : guess(real, draw)
      return type.maxLength && fake.length > type.maxLength ? fake.slice(0, type.maxLength) : fake
    }
    case 'integer':
      return integer(real, type.bytes, draw)
    case 'decimal':
      return decimal(real, draw.random)
    case 'uuid':
      return draw.faker.string.uuid()
    case 'date':
    case 'datetime':
    case 'time':
      return shiftTime(real, draw.random)
    case 'ip':
      return ip(real, draw.random)
    case 'bytes':
      return bytes(real, draw.random)
  }
}

/** A string with no format: shaped like the value, so dates stay dates and codes stay codes. */
function guess(real: string, draw: Draw): string {
  const { random, faker } = draw
  if (EMAIL.test(real)) return faker.internet.exampleEmail().toLowerCase()
  if (UUID.test(real)) return matchCase(real, faker.string.uuid())
  if (NUMBER.test(real)) return decimal(real, random)
  if (DATE.test(real) || DATETIME.test(real) || TIME.test(real)) return shiftTime(real, random)
  if (/\s/.test(real)) return text(real, faker)
  if (/^\p{L}{4,}$/u.test(real)) {
    const word = faker.word.sample({ length: { min: Math.max(1, real.length - 2), max: real.length + 2 }, strategy: 'closest' })
    return matchCase(real, real[0] === real[0]!.toUpperCase() ? word[0]!.toUpperCase() + word.slice(1) : word)
  }
  return shape(real, random)
}

const INTEGER_MAX = { 2: 32767n, 4: 2147483647n, 8: 9223372036854775807n } as const

/** Same sign and number of digits; a digit more each time a key's range is crowded. */
function integer(real: string, bytes: 2 | 4 | 8 | undefined, { random, attempt }: Draw): string {
  if (!/^-?\d+$/.test(real)) return decimal(real, random)
  const negative = real.startsWith('-')
  const digits = real.replace('-', '').replace(/^0+(?=\d)/, '').length + Math.floor(attempt / 16)
  const max = INTEGER_MAX[bytes ?? 8]
  // A zero stays possible only for a zero: ids start at 1.
  const lo = digits === 1 ? (/^-?0+$/.test(real) ? 0n : 1n) : 10n ** BigInt(digits - 1)
  let hi = 10n ** BigInt(digits) - 1n
  if (hi > max) hi = max
  const n = lo > hi ? random.bigint(0n, max) : random.bigint(lo, hi)
  return negative && n !== 0n ? `-${n}` : String(n)
}

/** Digits replaced: the same sign, digits and scale. */
function decimal(real: string, random: Random): string {
  if (/^[+-]?(NaN|Infinity)$/i.test(real)) return real
  if (!/\d/.test(real)) return shape(real, random)
  const exponent = real.search(/[eE]/)
  return exponent < 0 ? shape(real, random) : shape(real.slice(0, exponent), random) + real.slice(exponent)
}

/** Shifted by up to a year; the same shift for the same value. */
function shiftTime(real: string, random: Random): string {
  if (/^-?infinity$/.test(real)) return real
  const days = random.int(1, 365) * (random.next() < 0.5 ? -1 : 1)
  const seconds = random.int(0, 86_399)

  let m = DATE.exec(real)
  if (m) return formatDate(addDays(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!), days), m[1]!.length) + (m[4] ?? '')

  m = DATETIME.exec(real)
  if (m) {
    const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[5]!, +m[6]!, +m[7]!) + days * 86_400_000 + seconds * 1000
    const d = new Date(at)
    return `${formatDate(at, m[1]!.length)}${m[4]}${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${m[8] ?? ''}${m[9] ?? ''}${m[10] ?? ''}`
  }

  m = TIME.exec(real)
  if (m) {
    const s = (+m[1]! * 3600 + +m[2]! * 60 + +m[3]! + seconds) % 86_400
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}${m[4] ?? ''}${m[5] ?? ''}`
  }
  return shape(real, random)
}

function addDays(at: number, days: number): number {
  return at + days * 86_400_000
}

function formatDate(at: number, yearWidth: number): string {
  const d = new Date(at)
  return `${String(d.getUTCFullYear()).padStart(yearWidth, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** An address from a documentation range, with the real value's prefix length. */
function ip(real: string, random: Random): string {
  const slash = real.indexOf('/')
  const suffix = slash < 0 ? '' : real.slice(slash)
  if (real.includes(':')) {
    const groups = Array.from({ length: 6 }, () => random.int(0, 0xffff).toString(16))
    return `2001:db8:${groups.join(':')}${suffix}`
  }
  const net = random.pick(['192.0.2', '198.51.100', '203.0.113'])
  return `${net}.${random.int(1, 254)}${suffix}`
}

/** Random bytes of the same length, in Postgres's hex text form. */
function bytes(real: string, random: Random): string {
  const hex = real.startsWith('\\x') ? real.length - 2 : real.length * 2
  let out = '\\x'
  for (let i = 0; i < hex; i++) out += random.int(0, 15).toString(16)
  return out
}
