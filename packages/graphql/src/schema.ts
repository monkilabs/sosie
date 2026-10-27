import { linkByName, type Entity, type Field, type FieldType, type Schema } from '@sosie/core'
import {
  getNamedType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  type GraphQLField,
  type GraphQLOutputType,
  type GraphQLSchema,
} from 'graphql'

/**
 * The neutral schema from a GraphQL schema: each object and interface type is
 * an entity, each field holding a scalar or an enum is a field. A field that
 * holds another object is that object's row, and fakes as its own entity.
 */
export function readSchema(schema: GraphQLSchema): Schema {
  const roots = new Set([schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].filter(Boolean).map((t) => t!.name))
  const entities: Entity[] = []
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__') || roots.has(type.name) || !(isObjectType(type) || isInterfaceType(type))) continue
    const fields: Field[] = []
    for (const field of Object.values(type.getFields())) {
      const neutral = typeOf(field.type)
      if (!neutral) continue
      fields.push({
        id: `${type.name}.${field.name}`,
        name: field.name,
        type: neutral,
        ...(field.name === 'id' && { key: 'primary' as const }),
        ...(formatOf(field) && { format: formatOf(field) }),
      })
    }
    entities.push({ id: type.name, name: type.name, fields })
  }
  linkByName(entities)
  return { entities }
}

/** The neutral type of a field that holds a value; undefined for one that holds another object. */
export function typeOf(type: GraphQLOutputType): FieldType | undefined {
  if (isNonNullType(type)) return typeOf(type.ofType)
  if (isListType(type)) {
    const of = typeOf(type.ofType)
    return of && { kind: 'array', of }
  }
  if (isEnumType(type)) return { kind: 'enum', labels: type.getValues().map((v) => v.name) }
  if (!isScalarType(type)) return undefined
  return SCALARS[type.name.toLowerCase()] ?? { kind: 'string' }
}

/** Built-in scalars, and the custom ones APIs name alike. */
const SCALARS: Record<string, FieldType> = {
  id: { kind: 'string' },
  string: { kind: 'string' },
  int: { kind: 'integer', bytes: 4 },
  float: { kind: 'decimal' },
  boolean: { kind: 'boolean' },
  bigint: { kind: 'integer', bytes: 8 },
  long: { kind: 'integer', bytes: 8 },
  decimal: { kind: 'decimal' },
  datetime: { kind: 'datetime' },
  timestamp: { kind: 'datetime' },
  date: { kind: 'date' },
  time: { kind: 'time' },
  uuid: { kind: 'uuid' },
  json: { kind: 'json' },
  jsonobject: { kind: 'json' },
}

/** A format a custom scalar names: Email, EmailAddress, URL, URI. */
function formatOf(field: GraphQLField<unknown, unknown>): string | undefined {
  const name = getNamedType(field.type).name.toLowerCase()
  if (name === 'email' || name === 'emailaddress') return 'email'
  if (name === 'url' || name === 'uri') return 'url'
  return undefined
}
