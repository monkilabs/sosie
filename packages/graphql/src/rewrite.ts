import { referenceOf, type Field, type RequestScope } from '@sosie/core'
import {
  getNamedType,
  isAbstractType,
  isInterfaceType,
  isObjectType,
  Kind,
  TypeInfo,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type FieldNode,
  type GraphQLNamedType,
  type GraphQLSchema,
  type ValueNode,
} from 'graphql'
import { TYPENAME } from './fake.js'

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
  /** Whether a field's values pass, by sosie.yml. */
  passes: (field: Field) => boolean
}

/** A use of a variable: the argument or input key it is the value of, and the type that argument's field returns. */
type Use = { type: GraphQLNamedType | undefined; name: string }

/** `sosieTypename_: __typename`, asked of every object of an interface or a union, so Sosie knows how to fake it. */
const ASK_TYPENAME: FieldNode = { kind: Kind.FIELD, alias: { kind: Kind.NAME, value: TYPENAME }, name: { kind: Kind.NAME, value: '__typename' } }

/**
 * Turn the fakes in a request's arguments and variables back into real
 * values. An argument is looked up in the field it names on the type its
 * field returns: user(id:) in User.id, users(email:) in User.email,
 * orders(userId:) in User.id, node(id:) in the id of each type it may be;
 * text it names no field for, anywhere. A value compared with a field that
 * passes is real already, and stays as written. Each object of an interface
 * or a union is asked its type.
 */
export function rewrite(
  schema: GraphQLSchema,
  document: DocumentNode,
  variables: Record<string, unknown>,
  scope: RequestScope,
  names: Names,
): Rewritten {
  let changed = false
  /** Where each variable is used: the field each use compares with is where its value is looked up. */
  const usages = new Map<string, Use[]>()

  /** The fields an argument may name: on the type its field returns, or on each type an interface or a union may be. */
  const near = (name: string, type: GraphQLNamedType | undefined): Field[] => {
    if (!type) return []
    const types = isAbstractType(type) ? schema.getPossibleTypes(type) : isObjectType(type) || isInterfaceType(type) ? [type] : []
    const fields = types.map((t) => {
      const own = names.fields.get(`${t.name}.${name}`)
      if (own) return own
      const target = referenceOf(name, names.entityFor)
      return target ? names.fields.get(`${target}.id`) : undefined
    })
    return [...new Map(fields.filter((f) => f !== undefined).map((f) => [f.id, f])).values()]
  }

  const within = (key: string, outer: string, type: GraphQLNamedType | undefined) => (near(key, type).length ? key : outer)

  /**
   * The real value behind a fake: in the fields it may name, when they agree; text, but no bare number, anywhere
   * when none does. Compared with a field that passes, it stays: looked up anywhere, a fake of another field would
   * turn into that field's real value, which the passing field would show.
   */
  const lookup = (text: string, fields: Field[], anywhere = true): string | undefined => {
    if (fields.some(names.passes)) return undefined
    const reals = new Set(fields.map((f) => scope.lookup(text, f)).filter((r) => r !== undefined))
    if (reals.size) return reals.size === 1 ? [...reals][0] : undefined
    return anywhere && !/^\d+$/.test(text) ? scope.lookup(text) : undefined
  }

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
      // A boolean or a label the client saw is the fake of its field's: only that field turns it back.
      case Kind.BOOLEAN: {
        const real = lookup(String(node.value), near(name, type), false)
        if (real === undefined || real === String(node.value)) return node
        changed = true
        return { kind: Kind.BOOLEAN, value: real === 'true' }
      }
      case Kind.ENUM: {
        const real = lookup(node.value, near(name, type), false)
        if (real === undefined || real === node.value) return node
        changed = true
        return { kind: Kind.ENUM, value: real }
      }
      case Kind.LIST:
        return { ...node, values: node.values.map((v) => value(v, name, type)) }
      // A key that names no field, as an operator does (where: { id: { _eq: 8 } }), compares with the field around it.
      case Kind.OBJECT:
        return { ...node, fields: node.fields.map((f) => ({ ...f, value: value(f.value, within(f.name.value, name, type), type) })) }
      case Kind.VARIABLE:
        usages.set(node.name.value, [...(usages.get(node.name.value) ?? []), { type, name }])
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
          // A directive's argument (@include(if:)) names no field.
          if (info.getDirective()) return undefined
          const def = info.getFieldDef()
          const type = def ? getNamedType(def.type) : undefined
          return { ...node, value: value(node.value, node.name.value, type) }
        },
      },
      SelectionSet: {
        enter(node) {
          const parent = info.getParentType()
          if (!parent || !isAbstractType(parent) || node.selections.some((s) => s.kind === Kind.FIELD && s.alias?.value === TYPENAME)) return undefined
          changed = true
          return { ...node, selections: [...node.selections, ASK_TYPENAME] }
        },
      },
    }),
  )

  /**
   * A variable's value, looked up in the fields of all its uses at once: one value is sent for every use,
   * so it is real only when they agree, and stays as written when any use compares it with a field that passes.
   */
  const variable = (v: unknown, uses: Use[]): unknown => {
    if (Array.isArray(v)) return v.map((item) => variable(item, uses))
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, variable(item, uses.map((use) => ({ ...use, name: within(k, use.name, use.type) })))]))
    }
    const fields = [...new Map(uses.flatMap((use) => near(use.name, use.type)).map((f) => [f.id, f])).values()]
    if (typeof v === 'boolean') {
      const real = lookup(String(v), fields, false)
      if (real === undefined || real === String(v)) return v
      changed = true
      return real === 'true'
    }
    if (typeof v !== 'string' && typeof v !== 'number') return v
    const real = lookup(String(v), fields)
    if (real === undefined || real === String(v)) return v
    changed = true
    return typeof v === 'number' && /^-?\d+(\.\d+)?$/.test(real) ? Number(real) : real
  }
  const real = { ...variables }
  for (const [name, uses] of usages) if (name in real) real[name] = variable(real[name], uses)
  return { document: rewritten, variables: real, changed }
}
