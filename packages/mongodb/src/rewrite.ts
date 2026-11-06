import type { Field, RequestScope } from '@sosie/core'
import type { Document } from 'bson'
import { fromText, textOf } from './fake.js'
import { at, leaf, pipeline, type Shape } from './shape.js'

/** Operators whose value is compared with the field as it is: a fake there stands for a real value. */
const EQUALS = new Set(['$eq', '$ne', '$in', '$nin', '$all'])

const isDoc = (v: unknown): v is Document => !!v && typeof v === 'object' && !Array.isArray(v) && !('_bsontype' in v) && !(v instanceof Date)

/**
 * A filter, each fake compared by equality with a field turned back into its real value: in the field's domain, as
 * the shape says where the field comes from. `{ email: '…' }`, `$eq`, `$ne`, `$in`, `$nin`, `$all`, inside `$and`,
 * `$or`, `$nor`, `$not` and `$elemMatch`, a document compared whole, leaf by leaf, and in `$expr` a field compared by
 * `$eq`, `$ne` or `$in` with a value. Anything else (a range, a regular expression) is used as written.
 */
export function rewriteFilter(filter: unknown, shape: Shape, scope: RequestScope, prefix = ''): unknown {
  if (!isDoc(filter)) return filter
  const out: Document = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') out[key] = Array.isArray(value) ? value.map((f) => rewriteFilter(f, shape, scope, prefix)) : value
    else if (key === '$expr') out[key] = expression(value, shape, scope)
    else if (key.startsWith('$')) out[key] = value
    else out[key] = condition(value, `${prefix}${key}`, shape, scope)
  }
  return out
}

/** One field's condition: a value, a document compared whole, or operators. */
function condition(value: unknown, path: string, shape: Shape, scope: RequestScope): unknown {
  if (isDoc(value) && Object.keys(value).some((k) => k.startsWith('$'))) {
    const out: Document = {}
    for (const [op, arg] of Object.entries(value)) {
      if (EQUALS.has(op)) out[op] = Array.isArray(arg) ? arg.map((v) => compared(v, path, shape, scope)) : compared(arg, path, shape, scope)
      else if (op === '$not') out[op] = condition(arg, path, shape, scope)
      else if (op === '$elemMatch') {
        // Of values ({ $elemMatch: { $eq: … } }), or of documents ({ $elemMatch: { qty: … } }).
        out[op] = isDoc(arg) && Object.keys(arg).every((k) => k.startsWith('$')) ? condition(arg, path, shape, scope) : rewriteFilter(arg, shape, scope, `${path}.`)
      } else out[op] = arg
    }
    return out
  }
  return compared(value, path, shape, scope)
}

/** A field path of an expression ('$email', '$$ROOT.email', '$$CURRENT.email'), as a path of the documents; or undefined. */
function pathOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('$')) return undefined
  const path = value.replace(/^\$\$(ROOT|CURRENT)\./, '$')
  return path.startsWith('$') && !path.startsWith('$$') && path.length > 1 ? path.slice(1) : undefined
}

/** A value an expression compares, as the client wrote it: a literal, or `$literal`'s; never a path or a variable. */
function literal(value: unknown, path: string, shape: Shape, scope: RequestScope): unknown {
  if (isDoc(value) && Object.keys(value).length === 1 && '$literal' in value) return { $literal: compared(value.$literal, path, shape, scope) }
  if (typeof value === 'string' && value.startsWith('$')) return value
  if (isDoc(value) && Object.keys(value).some((k) => k.startsWith('$'))) return value
  return compared(value, path, shape, scope)
}

/**
 * `$expr`: a field compared by `$eq` or `$ne` with a value, either way round, or by `$in` with an array of values, inside
 * `$and`, `$or` and `$not` too. What an operator computes is no field's, and stays as written.
 */
function expression(expr: unknown, shape: Shape, scope: RequestScope): unknown {
  if (!isDoc(expr)) return expr
  const keys = Object.keys(expr)
  if (keys.length !== 1) return expr
  const op = keys[0]!
  const args = expr[op]
  if (op === '$and' || op === '$or' || op === '$not') {
    // One argument may be written without its array: { $not: { $eq: … } }.
    return { [op]: Array.isArray(args) ? args.map((a) => expression(a, shape, scope)) : expression(args, shape, scope) }
  }
  if (!Array.isArray(args) || args.length !== 2) return expr
  const [a, b] = args
  if (op === '$eq' || op === '$ne') {
    const left = pathOf(a)
    if (left !== undefined) return { [op]: [a, literal(b, left, shape, scope)] }
    const right = pathOf(b)
    if (right !== undefined) return { [op]: [literal(a, right, shape, scope), b] }
  }
  if (op === '$in') {
    const path = pathOf(a)
    if (path !== undefined && Array.isArray(b)) return { $in: [a, b.map((v) => literal(v, path, shape, scope))] }
  }
  return expr
}

/** A value compared with the field at `path`: its real value when it is a fake of that field. */
function compared(value: unknown, path: string, shape: Shape, scope: RequestScope): unknown {
  if (Array.isArray(value)) return value.map((v) => compared(v, path, shape, scope))
  if (isDoc(value)) {
    const out: Document = {}
    for (const [k, v] of Object.entries(value)) out[k] = compared(v, `${path}.${k}`, shape, scope)
    return out
  }
  const known = textOf(value)
  if (!known) return value
  const near = fieldAt(shape, path, known.type)
  if (!near) return value
  const real = scope.lookup(known.text, near)
  if (real === undefined || real === known.text) return value
  return fromText(real, value) ?? value
}

/** The field a path names in documents of this shape, as the faker named it; undefined for a computed one. */
export function fieldAt(shape: Shape, path: string, type: Field['type']): Field | undefined {
  const s = leaf(at(shape, path))
  if (s.kind !== 'field') return undefined
  return { id: `${s.entity}.${s.path}`, name: s.path.split('.').at(-1) || 'value', type }
}

/**
 * A pipeline, each $match turned back against the shape of the documents it filters: a $match after a $group
 * compares with what the group made, one in a $lookup's or a $unionWith's own pipeline with that collection's
 * fields, and a $graphLookup's restrictSearchWithMatch with the collection it searches.
 */
export function rewritePipeline(stages: Document[], start: Shape, scope: RequestScope, entityOf: (name: string) => string): Document[] {
  const out: Document[] = []
  let current = start
  for (const stage of stages) {
    const [name] = Object.keys(stage)
    if (name === '$match') out.push({ $match: rewriteFilter(stage.$match, current, scope) })
    else if (name === '$lookup' && Array.isArray(stage.$lookup?.pipeline) && typeof stage.$lookup.from === 'string') {
      const from = { kind: 'field' as const, entity: entityOf(stage.$lookup.from), path: '' }
      out.push({ $lookup: { ...stage.$lookup, pipeline: rewritePipeline(stage.$lookup.pipeline, from, scope, entityOf) } })
    } else if (name === '$unionWith' && isDoc(stage.$unionWith) && Array.isArray(stage.$unionWith.pipeline) && typeof stage.$unionWith.coll === 'string') {
      const other = { kind: 'field' as const, entity: entityOf(stage.$unionWith.coll), path: '' }
      out.push({ $unionWith: { ...stage.$unionWith, pipeline: rewritePipeline(stage.$unionWith.pipeline, other, scope, entityOf) } })
    } else if (name === '$graphLookup' && isDoc(stage.$graphLookup) && typeof stage.$graphLookup.from === 'string' && stage.$graphLookup.restrictSearchWithMatch) {
      const from = { kind: 'field' as const, entity: entityOf(stage.$graphLookup.from), path: '' }
      out.push({ $graphLookup: { ...stage.$graphLookup, restrictSearchWithMatch: rewriteFilter(stage.$graphLookup.restrictSearchWithMatch, from, scope) } })
    } else if (name === '$facet' && isDoc(stage.$facet)) {
      out.push({ $facet: Object.fromEntries(Object.entries(stage.$facet).map(([k, sub]) => [k, Array.isArray(sub) ? rewritePipeline(sub as Document[], current, scope, entityOf) : sub])) })
    } else out.push(stage)
    current = pipeline([stage], current, entityOf)
  }
  return out
}
