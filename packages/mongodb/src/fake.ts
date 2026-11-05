import { structuralKey, type Faker, type Field, type FieldType, type RequestScope } from '@sosie/core'
import { Binary, BSONRegExp, BSONSymbol, Code, DBRef, Decimal128, Double, Int32, Long, ObjectId, Timestamp, UUID, type Document } from 'bson'
import { child, leaf, type Shape } from './shape.js'

/** Keys that are values (a map keyed by email) fake in a domain of their own, each to one fake. */
const MAP_KEY: Field = { id: '$key', name: 'key', type: { kind: 'string' } }

/** A BSON value as the core fakes it: its text, and its neutral type. Undefined for one with no value to fake. */
export function textOf(value: unknown): { text: string; type: FieldType } | undefined {
  if (typeof value === 'string') return { text: value, type: { kind: 'string' } }
  if (typeof value === 'boolean') return { text: String(value), type: { kind: 'boolean' } }
  if (typeof value === 'number') return { text: String(value), type: Number.isInteger(value) ? { kind: 'integer', bytes: 4 } : { kind: 'decimal' } }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : { text: value.toISOString(), type: { kind: 'datetime' } }
  if (!value || typeof value !== 'object' || !('_bsontype' in value)) return undefined
  switch ((value as { _bsontype: string })._bsontype) {
    case 'Int32':
      return { text: String((value as Int32).value), type: { kind: 'integer', bytes: 4 } }
    case 'Long':
      return { text: (value as Long).toString(), type: { kind: 'integer', bytes: 8 } }
    case 'Double':
      return { text: String((value as Double).value), type: { kind: 'decimal' } }
    case 'Decimal128':
      return { text: (value as Decimal128).toString(), type: { kind: 'decimal' } }
    case 'ObjectId':
      return { text: (value as ObjectId).toHexString(), type: { kind: 'objectid' } }
    case 'Binary': {
      const b = value as Binary
      if (b.sub_type === Binary.SUBTYPE_UUID && b.position === 16) return { text: b.toUUID().toString(), type: { kind: 'uuid' } }
      return { text: `\\x${Buffer.from(b.buffer.subarray(0, b.position)).toString('hex')}`, type: { kind: 'bytes' } }
    }
    case 'Timestamp':
      return { text: new Date((value as Timestamp).t * 1000).toISOString(), type: { kind: 'datetime' } }
    case 'BSONRegExp':
      return { text: (value as BSONRegExp).pattern, type: { kind: 'string' } }
    case 'BSONSymbol':
      return { text: (value as BSONSymbol).value, type: { kind: 'string' } }
    case 'Code':
      return { text: String((value as Code).code), type: { kind: 'string' } }
    default:
      // MinKey, MaxKey, DBPointer: no value to fake.
      return undefined
  }
}

/** The fake's text, back in the type of the value it stands for; a fake that does not read as that type, null. */
export function fromText(text: string, like: unknown): unknown {
  if (typeof like === 'string') return text
  if (typeof like === 'boolean') return /^(t|true|y|yes|on|1)$/i.test(text)
  if (typeof like === 'number') return Number.isFinite(Number(text)) ? Number(text) : null
  if (like instanceof Date) {
    const d = new Date(text)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const type = (like as { _bsontype?: string })?._bsontype
  try {
    switch (type) {
      case 'Int32':
        return /^-?\d+$/.test(text) ? new Int32(Number(BigInt.asIntN(32, BigInt(text)))) : null
      case 'Long':
        return /^-?\d+$/.test(text) ? Long.fromBigInt(BigInt.asIntN(64, BigInt(text))) : null
      case 'Double':
        return Number.isFinite(Number(text)) || /^[+-]?(NaN|Infinity)$/.test(text) ? new Double(Number(text)) : null
      case 'Decimal128':
        return Decimal128.fromString(text)
      case 'ObjectId':
        return /^[0-9a-f]{24}$/i.test(text) ? new ObjectId(text.toLowerCase()) : null
      case 'Binary': {
        const b = like as Binary
        if (b.sub_type === Binary.SUBTYPE_UUID && /^[0-9a-f-]{36}$/i.test(text)) return new UUID(text)
        return /^\\x([0-9a-f]{2})*$/i.test(text) ? new Binary(Buffer.from(text.slice(2), 'hex'), b.sub_type) : null
      }
      case 'Timestamp': {
        const d = new Date(text)
        return Number.isNaN(d.getTime()) ? null : new Timestamp({ t: Math.max(0, Math.floor(d.getTime() / 1000)), i: (like as Timestamp).i })
      }
      case 'BSONRegExp':
        return new BSONRegExp(text, (like as BSONRegExp).options)
      case 'BSONSymbol':
        return new BSONSymbol(text)
      case 'Code':
        return new Code(text)
      default:
        return null
    }
  } catch {
    return null
  }
}

export interface FakeContext {
  faker: Faker
  scope: RequestScope | undefined
  /** What the client sent: a key it wrote is structure. */
  sent: string
  /** Told each field met, with its entity and type: the schema, learned as documents come. */
  met: (entity: string, path: string, type: FieldType) => void
}

/** A document, every value faked by where it came from: a collection's field, or computed. */
export function fakeDocument(doc: Document, shape: Shape, ctx: FakeContext): Document {
  return fakeValue(doc, shape, ctx) as Document
}

function fakeValue(value: unknown, shape: Shape, ctx: FakeContext): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => fakeValue(item, shape, ctx))
  // A reference to a document: the collection it names is structure, its id and any field beside it values.
  if (value instanceof DBRef) {
    return new DBRef(value.collection, fakeValue(value.oid, child(shape, '$id'), ctx) as ObjectId, value.db, fakeValue(value.fields, shape, ctx) as Document)
  }
  if (typeof value === 'object' && !('_bsontype' in value) && !(value instanceof Date)) {
    const out: Document = {}
    for (const [key, v] of Object.entries(value as Document)) {
      // A key the command built, or that looks like a word, is structure; any other is a value, faked.
      const built = shape.kind === 'doc' && shape.fields.has(key)
      const structural = built || (structuralKey(key) && !ctx.scope?.turnedBack(key)) || key === '_id'
      const name = structural ? key : String(ctx.faker.value(key, MAP_KEY, ctx.scope))
      Object.defineProperty(out, name, { value: fakeValue(v, child(shape, structural ? key : '*'), ctx), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  return fakeLeaf(value, leaf(shape), ctx)
}

function fakeLeaf(value: unknown, shape: Shape, ctx: FakeContext): unknown {
  if (shape.kind === 'literal') return value
  const known = textOf(value)
  if (!known) return value
  if (shape.kind === 'count' && known.type.kind === 'integer') return value
  if (shape.kind === 'field') {
    const name = shape.path.split('.').at(-1) || 'value'
    ctx.met(shape.entity, shape.path, known.type)
    const field: Field = { id: `${shape.entity}.${shape.path}`, name, type: known.type }
    const fake = ctx.faker.value(known.text, field, ctx.scope)
    return fake === null ? null : fromText(String(fake), value)
  }
  const fake = ctx.faker.computed(known.text, known.type, ctx.sent, ctx.scope)
  return fake === null ? null : fromText(String(fake), value)
}
