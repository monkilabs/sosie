import type { Field } from '@sosie/core'
import type { Operation } from './openapi.js'

/** 'users' to 'user', 'categories' to 'category', 'addresses' to 'address'. */
export function singular(word: string): string {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (/[^su]s$/.test(word) && !/is$/.test(word) && word.length > 3) return word.slice(0, -1)
  return word
}

/** A path segment that is a value, not a name: a number or a UUID. */
export const VALUE_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** What a request path names. */
export interface Route {
  /** The entity its response is about. */
  entity: string
  /** For each segment that is a value, the field it holds: /users/87 holds user.id. */
  values: Map<number, Field>
  operation?: Operation
}

/**
 * Read a path relative to the API's base: by its OpenAPI template when one
 * matches, otherwise by REST's habit, a collection then its member's id.
 * `entityFor` names an entity from a word of the path: 'users' to 'User' or 'user'.
 */
export function route(segments: string[], operations: Operation[], entityFor: (word: string) => string, isValue: (segment: string) => boolean): Route {
  const operation = operations.find(
    (op) => op.segments.length === segments.length && op.segments.every((s, i) => s.startsWith('{') || s === segments[i]),
  )
  const values = new Map<number, Field>()
  let entity = ''
  let collection = ''
  segments.forEach((segment, i) => {
    const param = operation?.segments[i]?.match(/^\{(.+)\}$/)?.[1]
    if (operation ? param !== undefined : isValue(segment)) {
      // A named parameter (/users/{userId}/orders) says whose id it is; a bare one is its collection's.
      const named = param && /^(.+?)(?:Id|_id)$/.exec(param)?.[1]
      const owner = named ? entityFor(named) : collection
      if (owner) values.set(i, idField(owner, segment))
    } else {
      collection = entityFor(segment)
      entity = collection
    }
  })
  return { entity: operation?.entity ?? (entity || 'root'), values, ...(operation && { operation }) }
}

/** The id field of an entity, typed by the value's shape. */
export function idField(entity: string, value: string): Field {
  const type = /^\d+$/.test(value) ? ({ kind: 'integer' } as const) : VALUE_SEGMENT.test(value) ? ({ kind: 'uuid' } as const) : ({ kind: 'string' } as const)
  return { id: `${entity}.id`, name: 'id', type, key: 'primary' }
}
