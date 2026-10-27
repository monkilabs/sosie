import { structuralKey, type Faker, type Field, type RequestScope } from '@sosie/core'
import { merged, refName, referenceOf, type Api, type Node } from './openapi.js'
import { idField, wordName, type Route } from './paths.js'

/** Keys of a response's root that wrap its rows: { data: [...] }. A field below one is named as if it were not there. */
const ENVELOPES = new Set(['data', 'items', 'results', 'records', 'rows', 'content', 'values', 'entries', 'hits', 'nodes', 'list'])

/** Keys that are values fake in a domain of their own, each to one fake. */
const MAP_KEY: Field = { id: '$key', name: 'key', type: { kind: 'string' } }

export interface FakeContext {
  faker: Faker
  /** The request's scope: a key that is a value it turned back is an echo, never structure. */
  scope?: RequestScope
  api: Api | undefined
  /** Fields of the OpenAPI schema, by id. */
  fields: Map<string, Field>
  entityFor: (word: string) => string
  /** A URL into the upstream API, rewritten to Sosie's address with its values faked; undefined for any other text. */
  url: (text: string) => string | undefined
  /** Items of a list at most; the rest are cut, as rows are by --max-rows. */
  maxItems: number
  /** Resolves now and then, to let other clients in while a large body is faked. */
  pace: () => Promise<void> | undefined
}

/** A JSON body, every value faked by the field it is: from the OpenAPI schema, or named by where it is. `cut` says a list was cut. */
export async function fakeBody(body: unknown, route: Route, ctx: FakeContext): Promise<{ body: unknown; cut: boolean }> {
  const state = { cut: false }
  return { body: await walk(body, route.operation?.response, route.entity, '', '', ctx, state), cut: state.cut }
}

async function walk(value: unknown, node: Node | undefined, entity: string, prefix: string, key: string, ctx: FakeContext, state: { cut: boolean }): Promise<unknown> {
  if (value === null || value === undefined) return value
  await ctx.pace()
  // A $ref starts the row of another entity.
  if (node?.$ref) {
    entity = refName(node.$ref)
    prefix = ''
  }
  let schema = node && ctx.api ? merged(node, ctx.api.schemas) : undefined
  // A body that does not have the shape its document says is named by where its values sit.
  if (schema && Array.isArray(value) !== (schema.type === 'array') && schema.type !== undefined && typeof value === 'object') schema = undefined
  if (Array.isArray(value)) {
    if (value.length > ctx.maxItems) state.cut = true
    const out: unknown[] = []
    for (const item of value.slice(0, ctx.maxItems)) out.push(await walk(item, schema?.items, entity, prefix, key, ctx, state))
    return out
  }
  if (typeof value === 'object') {
    const properties: Record<string, Node> | undefined = schema?.properties
    // A schema whose other keys are a map (additionalProperties: {schema}) says those keys are data.
    const map = schema?.additionalProperties && typeof schema.additionalProperties === 'object' && Object.keys(schema.additionalProperties).length ? (schema.additionalProperties as Node) : undefined
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const documented = properties?.[k]
      const structural = documented !== undefined || (!map && structuralKey(k) && !ctx.scope?.turnedBack(k))
      // A key that is a value (a map keyed by email) is faked, and never named in a field.
      const name = structural ? k : (ctx.faker.value(k, MAP_KEY, ctx.scope) as string)
      const envelope = !schema && !prefix && ENVELOPES.has(k) && v !== null && typeof v === 'object'
      out[name] = await walk(v, documented ?? map, entity, envelope ? '' : `${prefix}${structural ? k : '*'}.`, structural ? k : '', ctx, state)
    }
    return out
  }
  if (typeof value === 'string') {
    const url = ctx.url(value)
    if (url !== undefined) return url
  }
  const field = fieldAt(entity, prefix, key, value, ctx)
  const text = typeof value === 'string' ? value : String(value)
  const fake = ctx.faker.value(text, field, ctx.scope) as string | null
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

/**
 * The field a query parameter is compared with: id-like names by entity, a
 * name the OpenAPI document gives by its field, others by the route's entity.
 * A name that is not a word (q[Quillon]) is no field's: its values fake alike.
 */
export function queryField(name: string, value: string, route: Route, ctx: Pick<FakeContext, 'fields' | 'entityFor'>): Field {
  if (!wordName(name)) return { id: `${route.entity}.*`, name: '', type: { kind: 'string' } }
  if (name === 'id') return idField(route.entity, value)
  const target = referenceOf(name, ctx.entityFor)
  if (target) return idField(target, value)
  const documented = ctx.fields.get(`${route.entity}.${name}`)
  if (documented) return documented
  return { id: `${route.entity}.${name}`, name, type: /^(true|false)$/.test(value) ? { kind: 'boolean' } : { kind: 'string' } }
}
