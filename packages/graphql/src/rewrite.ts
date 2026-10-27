import { referenceOf, type Field, type RequestScope } from '@sosie/core'
import {
  getNamedType,
  isInterfaceType,
  isObjectType,
  Kind,
  TypeInfo,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type GraphQLNamedType,
  type GraphQLSchema,
  type ValueNode,
} from 'graphql'

/** What a request looks like once its fakes are real values again. */
export interface Rewritten {
  document: DocumentNode
  variables: Record<string, unknown>
  changed: boolean
}

export interface Names {
  /** Fields of the neutral schema, by id. */
  fields: Map<string, Field>
  /** An entity's name from a word: 'user' to 'User'. */
  entityFor: (word: string) => string | undefined
}

/**
 * Turn the fakes in a request's arguments and variables back into real
 * values. An argument is looked up in the field it names on the type its
 * field returns: user(id:) in User.id, users(email:) in User.email,
 * orders(userId:) in User.id; text it names no field for, anywhere.
 */
export function rewrite(
  schema: GraphQLSchema,
  document: DocumentNode,
  variables: Record<string, unknown>,
  scope: RequestScope,
  names: Names,
): Rewritten {
  let changed = false
  const usages = new Map<string, { type: GraphQLNamedType | undefined; name: string }>()

  const near = (name: string, type: GraphQLNamedType | undefined): Field | undefined => {
    if (!type || !(isObjectType(type) || isInterfaceType(type))) return undefined
    const own = names.fields.get(`${type.name}.${name}`)
    if (own) return own
    const target = referenceOf(name, names.entityFor)
    return target ? names.fields.get(`${target}.id`) : undefined
  }

  const lookup = (text: string, field: Field | undefined): string | undefined =>
    (field && scope.lookup(text, field)) ?? (/^\d+$/.test(text) ? undefined : scope.lookup(text))

  const value = (node: ValueNode, name: string, type: GraphQLNamedType | undefined): ValueNode => {
    switch (node.kind) {
      case Kind.STRING:
      case Kind.INT:
      case Kind.FLOAT: {
        const real = lookup(node.value, near(name, type))
        if (real === undefined || real === node.value) return node
        changed = true
        return node.kind === Kind.STRING || !/^-?\d+(\.\d+)?$/.test(real)
          ? { kind: Kind.STRING, value: real }
          : { kind: /\./.test(real) ? Kind.FLOAT : Kind.INT, value: real }
      }
      case Kind.LIST:
        return { ...node, values: node.values.map((v) => value(v, name, type)) }
      case Kind.OBJECT:
        return { ...node, fields: node.fields.map((f) => ({ ...f, value: value(f.value, f.name.value, type) })) }
      case Kind.VARIABLE:
        usages.set(node.name.value, { type, name })
        return node
      default:
        return node
    }
  }

  const info = new TypeInfo(schema)
  const rewritten = visit(
    document,
    visitWithTypeInfo(info, {
      Argument: {
        enter(node) {
          const def = info.getFieldDef()
          const type = def ? getNamedType(def.type) : undefined
          return { ...node, value: value(node.value, node.name.value, type) }
        },
      },
    }),
  )

  const variable = (v: unknown, name: string, type: GraphQLNamedType | undefined): unknown => {
    if (Array.isArray(v)) return v.map((item) => variable(item, name, type))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, variable(item, k, type)]))
    if (typeof v !== 'string' && typeof v !== 'number') return v
    const real = lookup(String(v), near(name, type))
    if (real === undefined || real === String(v)) return v
    changed = true
    return typeof v === 'number' && /^-?\d+(\.\d+)?$/.test(real) ? Number(real) : real
  }
  const real = { ...variables }
  for (const [name, usage] of usages) if (name in real) real[name] = variable(real[name], usage.name, usage.type)
  return { document: rewritten, variables: real, changed }
}
