import { structuralKey, type Faker, type Field } from '@sosie/core'
import { merged, refName, referenceOf, type Api, type Node } from './openapi.js'
import { idField, VALUE_SEGMENT, type Route } from './paths.js'

/** Keys of a response's root that wrap its rows: { data: [...] }. A field below one is named as if it were not there. */
const ENVELOPES = new Set(['data', 'items', 'results', 'records', 'rows', 'content', 'values', 'entries', 'hits', 'nodes', 'list'])

export interface FakeContext {
  faker: Faker
  api: Api | undefined
  /** Fields of the OpenAPI schema, by id. */
  fields: Map<string, Field>
  entityFor: (word: string) => string
  /** What the client sent: a JSON key it wrote is structure. */
  sent: string
  /** A URL into the upstream API, rewritten to Sosie's address with its values faked; undefined for any other text. */
  url: (text: string) => string | undefined
}

/** A JSON body, every value faked by the field it is: from the OpenAPI schema, or named by where it is. */
export function fakeBody(body: unknown, route: Route, ctx: FakeContext): unknown {
  return walk(body, route.operation?.response, route.entity, '', '', ctx)
}

function walk(value: unknown, node: Node | undefined, entity: string, prefix: string, key: string, ctx: FakeContext): unknown {
  if (value === null || value === undefined) return value
  // A $ref starts the row of another entity.
  if (node?.$ref) {
    entity = refName(node.$ref)
    prefix = ''
  }
  let schema = node && ctx.api ? merged(node, ctx.api.schemas) : undefined
  // A body that does not have the shape its document says is named by where its values sit.
  if (schema && Array.isArray(value) !== (schema.type === 'array') && schema.type !== undefined && typeof value === 'object') schema = undefined
  if (Array.isArray(value)) return value.map((item) => walk(item, schema?.items, entity, prefix, key, ctx))
  if (typeof value === 'object') {
    const properties: Record<string, Node> | undefined = schema?.properties
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        const documented = properties?.[k]
        const structural = documented !== undefined || structuralKey(k)
        // A key that is a value (a map keyed by email) is faked, and never named in a field.
        const out = structural ? k : (ctx.faker.computed(k, { kind: 'string' }, ctx.sent) as string)
        const envelope = !schema && !prefix && ENVELOPES.has(k) && v !== null && typeof v === 'object'
        const child = documented ?? (schema?.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined)
        return [out, walk(v, child, entity, envelope ? '' : `${prefix}${structural ? k : '*'}.`, structural ? k : '', ctx)]
      }),
    )
  }
  if (typeof value === 'string') {
    const url = ctx.url(value)
    if (url !== undefined) return url
  }
  const field = fieldAt(entity, prefix, key, value, ctx)
  const text = typeof value === 'string' ? value : String(value)
  const fake = ctx.faker.value(text, field) as string | null
  if (fake === null) return null
  if (typeof value === 'number') return Number.isFinite(Number(fake)) ? Number(fake) : fake
  if (typeof value === 'boolean') return /^(t|true)$/i.test(fake)
  return fake
}

/** The field a value is: the schema's, or one named by where the value sits in its entity. */
function fieldAt(entity: string, prefix: string, key: string, value: unknown, ctx: FakeContext): Field {
  const id = `${entity}.${prefix.slice(0, -1)}`
  const documented = ctx.fields.get(id)
  if (documented) return documented
  const type: Field['type'] =
    typeof value === 'number' ? (Number.isInteger(value) ? { kind: 'integer' } : { kind: 'decimal' }) : typeof value === 'boolean' ? { kind: 'boolean' } : { kind: 'string' }
  if (key === 'id' && prefix === 'id.') return { ...idField(entity, String(value)), type }
  const target = referenceOf(key, (name) => ctx.entityFor(name))
  return { id, name: key || 'value', type, ...(target && target !== entity && { references: `${target}.id` }) }
}

/** The fields a request's query parameters are compared with: id-like names by entity, others by the route's entity. */
export function queryField(name: string, value: string, route: Route, entityFor: (word: string) => string): Field {
  if (name === 'id') return idField(route.entity, value)
  const target = referenceOf(name, entityFor)
  if (target) return idField(target, value)
  return { id: `${route.entity}.${name}`, name, type: VALUE_SEGMENT.test(value) && /^\d+$/.test(value) ? { kind: 'integer' } : { kind: 'string' } }
}
