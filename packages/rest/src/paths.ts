import { singular, structuralKey, type Field } from '@sosie/core'
import type { Operation } from './openapi.js'

export { singular }

/** A path segment that is a value, not a name: a number or a UUID. */
export const VALUE_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Whether a decoded segment is one segment to any server: no / or \ in it, and not . or ..; an
 * API, or a proxy before it, that decodes %2F and resolves .. would read another path than Sosie.
 */
export function oneSegment(segment: string): boolean {
  return !/[/\\]/.test(segment) && segment !== '.' && segment !== '..'
}

/** The segments of a path, decoded; undefined when a % starts no escape. */
export function segmentsOf(path: string): string[] | undefined {
  try {
    return path.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return undefined
  }
}

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
 * `isValue` says which other segments are values; `afterName` is whether the
 * one before named a collection.
 */
export function route(
  segments: string[],
  operations: Operation[],
  entityFor: (word: string) => string,
  isValue: (segment: string, index: number, afterName: boolean) => boolean,
): Route {
  const operation = operations.find(
    (op) => op.segments.length === segments.length && op.segments.every((s, i) => s.startsWith('{') || s === segments[i]),
  )
  const values = new Map<number, Field>()
  let entity = ''
  let collection = ''
  let afterName = false
  segments.forEach((segment, i) => {
    const param = operation?.segments[i]?.match(/^\{(.+)\}$/)?.[1]
    if (operation ? param !== undefined : isValue(segment, i, afterName)) {
      // A named parameter (/users/{userId}/orders) says whose id it is; a bare one is its collection's.
      const named = param && /^(.+?)(?:Id|_id)$/.exec(param)?.[1]
      values.set(i, idField((named ? entityFor(named) : collection) || 'root', segment))
      afterName = false
    } else {
      collection = entityFor(segment)
      entity = collection
      afterName = true
    }
  })
  return { entity: operation?.entity ?? (entity || 'root'), values, ...(operation && { operation }) }
}

/**
 * Whether a segment of a path is a value, by REST's habit: a number or a UUID,
 * or whatever follows a collection's name (/users/jdoe), unless it is a word
 * Sosie knows as a name of the API's.
 */
export function valueByHabit(segment: string, afterName: boolean, known: Set<string>): boolean {
  return !known.has(segment) && (VALUE_SEGMENT.test(segment) || afterName)
}

/** Words of a link's path that are neither known nor values fake here: a domain of their own, never a value's field. */
export const PATH_WORD: Field = { id: '$path', name: 'path', type: { kind: 'string' }, format: 'shape', words: true }

/** Names of a link's query parameters that are not words (q[Quillon]) fake here. */
export const QUERY_NAME: Field = { id: '$query', name: 'query', type: { kind: 'string' }, format: 'shape', words: true }

/** Whether a query parameter's name is structure: words, as in page, sort-by, filter[email] or pageSize, with indexes after a word (ids[0]). */
export function wordName(name: string): boolean {
  const [first, ...rest] = name.split(/[-.[\]]+/).filter(Boolean)
  return first !== undefined && structuralKey(first) && rest.every((part) => structuralKey(part) || /^\d+$/.test(part))
}

/** Query parameters whose numbers say where a page starts and how long it is: they stay as written. */
export const PAGING = new Set(['page', 'limit', 'offset', 'per_page', 'perPage', 'page_size', 'pageSize', 'size', 'skip', 'take'])

/** The id field of an entity, typed by the value's shape. */
export function idField(entity: string, value: string): Field {
  const type = /^\d+$/.test(value) ? ({ kind: 'integer' } as const) : VALUE_SEGMENT.test(value) ? ({ kind: 'uuid' } as const) : ({ kind: 'string' } as const)
  return { id: `${entity}.id`, name: 'id', type, key: 'primary' }
}
