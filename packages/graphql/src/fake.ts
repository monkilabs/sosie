import type { Faker, Field, RequestScope } from '@sosie/core'
import {
  getNamedType,
  isAbstractType,
  isLeafType,
  isObjectType,
  Kind,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type SelectionNode,
} from 'graphql'
import { typeOf } from './schema.js'

/** The alias Sosie asks each object of an interface or a union to name its type under, never shown. */
export const TYPENAME = 'sosieTypename_'

export interface FakeContext {
  schema: GraphQLSchema
  faker: Faker
  /** The request's scope: a JSON key that is a value it turned back is an echo, never structure. */
  scope?: RequestScope
  /** What the client sent: a key it wrote in the query is structure. */
  sent?: string
  fields: Map<string, Field>
  fragments: Record<string, FragmentDefinitionNode>
  /** Items of a list at most; the rest are cut, as rows are by --max-rows. */
  maxItems: number
  /** Resolves now and then, to let other clients in while a large answer is faked. */
  pace: () => Promise<void> | undefined
}

/**
 * The `data` of a response, every leaf faked by the schema field it is,
 * through aliases, fragments and nested objects; `__typename` as the schema
 * names it. `cut` says a list was cut.
 */
export async function fakeData(
  data: unknown,
  selections: readonly SelectionNode[],
  root: GraphQLObjectType,
  ctx: FakeContext,
): Promise<{ data: unknown; cut: boolean }> {
  const state = { cut: false }
  return { data: await walk(data, selections, root, ctx, state), cut: state.cut }
}

async function walk(value: unknown, selections: readonly SelectionNode[], type: GraphQLNamedType, ctx: FakeContext, state: { cut: boolean }): Promise<unknown> {
  if (value === null || value === undefined) return null
  await ctx.pace()
  if (Array.isArray(value)) {
    if (value.length > ctx.maxItems) state.cut = true
    const out: unknown[] = []
    for (const item of value.slice(0, ctx.maxItems)) out.push(await walk(item, selections, type, ctx, state))
    return out
  }
  // In an object's place, anything but an object is shown as nothing.
  if (typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  // An object of an interface or a union names its type, as Sosie asked it to; one that does not, or names
  // a type it cannot be, cannot be faked by its fields, and is shown as nothing.
  const named = isAbstractType(type) ? ctx.schema.getType(String(row[TYPENAME])) : type
  if (!named || !isObjectType(named) || (isAbstractType(type) && !ctx.schema.isSubType(type, named))) return null
  // The same response key asked for twice, by aliases or fragments, is one field with its selections merged.
  const groups = new Map<string, FieldNode[]>()
  for (const node of collect(selections, named, ctx)) {
    const key = node.alias?.value ?? node.name.value
    groups.set(key, [...(groups.get(key) ?? []), node])
  }
  const out: Record<string, unknown> = {}
  for (const [key, nodes] of groups) {
    if (!(key in row)) continue
    const name = nodes[0]!.name.value
    if (name === '__typename') {
      out[key] = named.name
      continue
    }
    const def = named.getFields()[name]
    if (!def) continue
    const inner = getNamedType(def.type)
    out[key] = isLeafType(inner)
      ? await leaf(row[key], ctx.fields.get(`${named.name}.${name}`) ?? { id: `${named.name}.${name}`, name, type: typeOf(def.type) ?? { kind: 'string' } }, ctx, state)
      : await walk(row[key], nodes.flatMap((n) => n.selectionSet?.selections ?? []), inner, ctx, state)
  }
  return out
}

/** The fields a selection set asks of an object of a type, its fragments' included. */
function collect(selections: readonly SelectionNode[], type: GraphQLObjectType, ctx: FakeContext, seen = new Set<string>()): FieldNode[] {
  const fields: FieldNode[] = []
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) fields.push(selection)
    else if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (applies(selection.typeCondition?.name.value, type, ctx)) fields.push(...collect(selection.selectionSet.selections, type, ctx, seen))
    } else if (!seen.has(selection.name.value)) {
      const fragment = ctx.fragments[selection.name.value]
      seen.add(selection.name.value)
      if (fragment && applies(fragment.typeCondition.name.value, type, ctx)) fields.push(...collect(fragment.selectionSet.selections, type, ctx, seen))
    }
  }
  return fields
}

/** Whether a fragment on a type applies to an object of a type. */
function applies(condition: string | undefined, type: GraphQLObjectType, ctx: FakeContext): boolean {
  if (!condition || condition === type.name) return true
  const target = ctx.schema.getType(condition)
  return !!target && isAbstractType(target) && ctx.schema.isSubType(target, type)
}

async function leaf(value: unknown, field: Field, ctx: FakeContext, state: { cut: boolean }): Promise<unknown> {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length > ctx.maxItems) state.cut = true
    const item = field.type.kind === 'array' ? { ...field, type: field.type.of } : field
    const out: unknown[] = []
    for (const v of value.slice(0, ctx.maxItems)) out.push(await leaf(v, item, ctx, state))
    return out
  }
  await ctx.pace()
  if (typeof value === 'object') {
    // An object in a scalar's place: a JSON scalar's by its field, any other custom scalar's (jsonb, Map, Any) as JSON a query built.
    if (ctx.faker.passes(field)) return value
    const json = JSON.stringify(value)
    const fake = field.type.kind === 'json' ? ctx.faker.value(json, field, ctx.scope) : ctx.faker.computed(json, { kind: 'json' }, ctx.sent, ctx.scope)
    return JSON.parse(fake as string)
  }
  const fake = ctx.faker.value(String(value), field, ctx.scope) as string | null
  if (fake === null) return null
  if (typeof value === 'number') return Number.isFinite(Number(fake)) ? Number(fake) : fake
  if (typeof value === 'boolean') return /^(t|true)$/i.test(fake)
  return fake
}
