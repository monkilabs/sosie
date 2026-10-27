import type { Faker, Field } from '@sosie/core'
import {
  getNamedType,
  isAbstractType,
  isInterfaceType,
  isLeafType,
  isObjectType,
  Kind,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLSchema,
  type SelectionSetNode,
  type FieldNode,
} from 'graphql'
import { typeOf } from './schema.js'

export interface FakeContext {
  schema: GraphQLSchema
  faker: Faker
  fields: Map<string, Field>
  fragments: Record<string, FragmentDefinitionNode>
}

/**
 * The `data` of a response, every leaf faked by the schema field it is,
 * through aliases, fragments and nested objects; `__typename` and
 * introspection as they are.
 */
export function fakeData(data: unknown, selections: SelectionSetNode, root: GraphQLNamedType, ctx: FakeContext): unknown {
  return walk(data, selections, root, ctx)
}

function walk(value: unknown, selections: SelectionSetNode | undefined, type: GraphQLNamedType, ctx: FakeContext): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => walk(item, selections, type, ctx))
  if (typeof value !== 'object' || !selections) return value
  const row = value as Record<string, unknown>
  // An object of an interface or a union says which type it is when asked; otherwise its fields are the interface's.
  const concrete = isAbstractType(type) && typeof row.__typename === 'string' ? ctx.schema.getType(row.__typename) ?? type : type
  const out: Record<string, unknown> = {}
  for (const node of collect(selections, concrete, ctx)) {
    const key = node.alias?.value ?? node.name.value
    if (!(key in row)) continue
    const name = node.name.value
    if (name.startsWith('__')) {
      out[key] = row[key]
      continue
    }
    const owner = ownerOf(concrete, name, ctx)
    const def = owner && (isObjectType(owner) || isInterfaceType(owner)) ? owner.getFields()[name] : undefined
    if (!def) continue
    const named = getNamedType(def.type)
    out[key] = isLeafType(named)
      ? leaf(row[key], ctx.fields.get(`${owner!.name}.${name}`) ?? { id: `${owner!.name}.${name}`, name, type: typeOf(def.type) ?? { kind: 'string' } }, ctx)
      : walk(row[key], node.selectionSet, named, ctx)
  }
  return out
}

/** The fields a selection set asks of an object of a type, its fragments' included. */
function collect(selections: SelectionSetNode, type: GraphQLNamedType, ctx: FakeContext, seen = new Set<string>()): FieldNode[] {
  const fields: FieldNode[] = []
  for (const selection of selections.selections) {
    if (selection.kind === Kind.FIELD) fields.push(selection)
    else if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (applies(selection.typeCondition?.name.value, type, ctx)) fields.push(...collect(selection.selectionSet, type, ctx, seen))
    } else if (selection.kind === Kind.FRAGMENT_SPREAD && !seen.has(selection.name.value)) {
      const fragment = ctx.fragments[selection.name.value]
      seen.add(selection.name.value)
      if (fragment && applies(fragment.typeCondition.name.value, type, ctx)) fields.push(...collect(fragment.selectionSet, type, ctx, seen))
    }
  }
  return fields
}

function applies(condition: string | undefined, type: GraphQLNamedType, ctx: FakeContext): boolean {
  if (!condition || condition === type.name) return true
  const target = ctx.schema.getType(condition)
  if (!target || !isAbstractType(target)) return isAbstractType(type)
  return isObjectType(type) ? ctx.schema.isSubType(target, type) : true
}

/** The type whose field this is: the object's own, or, for an interface or union, the first type that has it. */
function ownerOf(type: GraphQLNamedType, name: string, ctx: FakeContext): GraphQLNamedType | undefined {
  if ((isObjectType(type) || isInterfaceType(type)) && type.getFields()[name]) return type
  if (isAbstractType(type)) return ctx.schema.getPossibleTypes(type).find((t) => t.getFields()[name])
  return undefined
}

function leaf(value: unknown, field: Field, ctx: FakeContext): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => leaf(item, field.type.kind === 'array' ? { ...field, type: field.type.of } : field, ctx))
  if (typeof value === 'object') return JSON.parse(ctx.faker.value(JSON.stringify(value), { ...field, type: { kind: 'json' } }) as string)
  const fake = ctx.faker.value(String(value), field) as string | null
  if (fake === null) return null
  if (typeof value === 'number') return Number.isFinite(Number(fake)) ? Number(fake) : fake
  if (typeof value === 'boolean') return /^(t|true)$/i.test(fake)
  return fake
}
