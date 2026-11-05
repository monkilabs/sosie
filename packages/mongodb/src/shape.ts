import type { Document } from 'bson'

/**
 * Where each value of a result comes from. MongoDB says nothing of it, as MySQL's metadata does: Sosie reads it from
 * the command. A find's documents are its collection's, through its projection; an aggregation's are read stage by
 * stage, each stage taking the shape of the documents before it and giving the shape of those after.
 */
export type Shape =
  /** What is at `path` in a collection's documents: a leaf is that field's value, a key below it the field below. */
  | { kind: 'field'; entity: string; path: string }
  /** Computed from values: faked by its type. */
  | { kind: 'computed' }
  /** A count: a number that is no value of a row. */
  | { kind: 'count' }
  /** Written by the client: it passes. */
  | { kind: 'literal' }
  /** A document built by the command: its named keys, and what any other key is. */
  | { kind: 'doc'; fields: Map<string, Shape>; rest: Shape }
  /** One of several, as $unionWith mixes two collections' documents. */
  | { kind: 'either'; of: Shape[] }

export const COMPUTED: Shape = { kind: 'computed' }
const COUNT: Shape = { kind: 'count' }
const LITERAL: Shape = { kind: 'literal' }

/** A collection's documents, whole. */
export const collection = (entity: string): Shape => ({ kind: 'field', entity, path: '' })

/** The shape of what is under a key. */
export function child(shape: Shape, key: string): Shape {
  switch (shape.kind) {
    case 'field':
      return { ...shape, path: shape.path ? `${shape.path}.${key}` : key }
    case 'doc':
      // A key the stage did not name is what that key was in the documents it was given.
      return shape.fields.get(key) ?? child(shape.rest, key)
    case 'either':
      return either(shape.of.map((s) => child(s, key)))
    default:
      return shape
  }
}

/** The shape at a dotted path. */
export function at(shape: Shape, path: string): Shape {
  return path.split('.').reduce(child, shape)
}

/** One of several: the field they all are, or computed where they differ. */
export function either(of: Shape[]): Shape {
  const first = of[0]
  if (!first) return COMPUTED
  if (of.every((s) => same(s, first))) return first
  return of.some((s) => s.kind === 'doc' || s.kind === 'either') ? { kind: 'either', of } : COMPUTED
}

function same(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'field' && b.kind === 'field') return a.entity === b.entity && a.path === b.path
  return a.kind !== 'doc' && a.kind !== 'either'
}

/** A leaf's shape: either resolved to the field all its branches agree on, or computed. */
export function leaf(shape: Shape): Shape {
  if (shape.kind !== 'either') return shape
  const resolved = shape.of.map(leaf)
  return resolved.every((s) => same(s, resolved[0]!)) ? resolved[0]! : COMPUTED
}

/** A document of named keys over another shape; dotted keys nest. */
function doc(rest: Shape, entries: [string, Shape][]): Shape {
  const fields = new Map<string, Shape>()
  for (const [key, value] of entries) set(fields, key.split('.'), value, rest)
  return { kind: 'doc', fields, rest }
}

function set(fields: Map<string, Shape>, parts: string[], value: Shape, rest: Shape): void {
  const [first, ...more] = parts as [string, ...string[]]
  if (!more.length) {
    fields.set(first, value)
    return
  }
  const existing = fields.get(first)
  const inner = existing?.kind === 'doc' ? existing : { kind: 'doc' as const, fields: new Map<string, Shape>(), rest: existing ?? child(rest, first) }
  set(inner.fields, more, value, inner.rest)
  fields.set(first, inner)
}

const isOperator = (o: unknown): o is Document => !!o && typeof o === 'object' && !Array.isArray(o) && !('_bsontype' in o) && !(o instanceof Date)
const bsonNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && '_bsontype' in v) {
    const t = (v as { _bsontype: string })._bsontype
    if (t === 'Int32' || t === 'Double' || t === 'Long' || t === 'Decimal128') return Number(String(v))
  }
  return undefined
}
const truthy = (v: unknown) => v === true || (bsonNumber(v) ?? 0) !== 0

/**
 * The shape of an aggregation expression, over the current document: a field path is that field's, a literal is the
 * client's, a document of expressions is built from them, and anything an operator computes is computed.
 */
export function expression(e: unknown, current: Shape): Shape {
  if (typeof e === 'string') {
    if (e.startsWith('$$')) {
      const [variable, ...path] = e.slice(2).split('.')
      if (variable === 'ROOT' || variable === 'CURRENT') return path.length ? at(current, path.join('.')) : current
      return COMPUTED
    }
    if (e.startsWith('$')) return at(current, e.slice(1))
    return LITERAL
  }
  if (Array.isArray(e)) return e.length ? either(e.map((x) => expression(x, current))) : LITERAL
  if (!isOperator(e)) return LITERAL
  const keys = Object.keys(e)
  const op = keys[0]
  if (op?.startsWith('$')) {
    const arg = e[op]
    switch (op) {
      case '$literal':
        return LITERAL
      // Each picks one of the values it is given, as they are.
      case '$first':
      case '$last':
      case '$arrayElemAt':
      case '$ifNull':
        return Array.isArray(arg) ? (op === '$ifNull' ? either(arg.map((x) => expression(x, current))) : expression(arg[0], current)) : expression(arg, current)
      default:
        return COMPUTED
    }
  }
  return doc(COMPUTED, keys.map((k) => [k, expression(e[k], current)]))
}

/** An accumulator of $group, $bucket or $setWindowFields. */
function accumulator(spec: unknown, current: Shape): Shape {
  if (!isOperator(spec)) return COMPUTED
  const [op] = Object.keys(spec)
  const arg = op ? spec[op] : undefined
  switch (op) {
    case '$sum':
      return bsonNumber(arg) === 1 ? COUNT : COMPUTED
    case '$count':
      return COUNT
    // Each gives values of the field it is given, as they are.
    case '$first':
    case '$last':
    case '$min':
    case '$max':
    case '$push':
    case '$addToSet':
      return expression(arg, current)
    default:
      return COMPUTED
  }
}

/** A projection's shape: inclusion builds a document of what it names, exclusion leaves the rest as it was. */
export function projection(spec: Document | undefined, current: Shape): Shape {
  if (!spec || !Object.keys(spec).length) return current
  const entries = Object.entries(spec)
  const inclusion = entries.some(([k, v]) => k !== '_id' && (isOperator(v) || typeof v === 'string' || truthy(v) || Array.isArray(v)))
  if (!inclusion) return current
  const out: [string, Shape][] = []
  if (!('_id' in spec)) out.push(['_id', child(current, '_id')])
  for (const [key, value] of entries) {
    if (isOperator(value) && Object.keys(value).some((k) => ['$slice', '$elemMatch'].includes(k))) out.push([key, at(current, key)])
    else if (isOperator(value) || typeof value === 'string' || Array.isArray(value)) out.push([key, expression(value, current)])
    else if (truthy(value)) out.push([key.replace(/\.\$$/, ''), at(current, key.replace(/\.\$$/, ''))])
  }
  return doc(COMPUTED, out)
}

/** The shape of the documents a pipeline gives, from those it is given; `entityOf` names another collection by name. */
export function pipeline(stages: Document[], start: Shape, entityOf: (name: string) => string): Shape {
  let current = start
  for (const stage of stages) current = stageShape(stage, current, entityOf)
  return current
}

function stageShape(stage: Document, current: Shape, entityOf: (name: string) => string): Shape {
  const [name] = Object.keys(stage)
  const spec = name ? stage[name] : undefined
  switch (name) {
    case '$match':
    case '$sort':
    case '$limit':
    case '$skip':
    case '$sample':
    case '$redact':
    case '$unset':
    case '$search':
    case '$vectorSearch':
    case '$unwind':
      if (name === '$unwind' && isOperator(spec) && typeof spec.includeArrayIndex === 'string') return doc(current, [[spec.includeArrayIndex, COMPUTED]])
      return current
    case '$project':
      return projection(spec as Document, current)
    case '$addFields':
    case '$set':
      return doc(current, Object.entries(spec as Document).map(([k, v]) => [k, expression(v, current)]))
    case '$replaceRoot':
      return expression((spec as Document).newRoot, current)
    case '$replaceWith':
      return expression(spec, current)
    case '$group': {
      const entries = Object.entries(spec as Document).map(([k, v]): [string, Shape] => [k, k === '_id' ? expression(v, current) : accumulator(v, current)])
      return doc(COMPUTED, entries)
    }
    case '$count':
      return doc(COMPUTED, [[String(spec), COUNT]])
    case '$sortByCount':
      return doc(COMPUTED, [
        ['_id', expression(spec, current)],
        ['count', COUNT],
      ])
    case '$bucket': {
      const output = isOperator((spec as Document).output) ? Object.entries((spec as Document).output as Document) : [['count', { $sum: 1 }]]
      return doc(COMPUTED, [['_id', LITERAL], ...output.map(([k, v]): [string, Shape] => [k as string, accumulator(v, current)])])
    }
    case '$bucketAuto': {
      const groupBy = expression((spec as Document).groupBy, current)
      const output = isOperator((spec as Document).output) ? Object.entries((spec as Document).output as Document) : [['count', { $sum: 1 }]]
      return doc(COMPUTED, [
        ['_id', doc(COMPUTED, [['min', groupBy], ['max', groupBy]])],
        ...output.map(([k, v]): [string, Shape] => [k as string, accumulator(v, current)]),
      ])
    }
    case '$facet':
      return doc(
        COMPUTED,
        Object.entries(spec as Document).map(([k, sub]) => [k, pipeline(sub as Document[], current, entityOf)]),
      )
    case '$lookup': {
      const s = spec as Document
      const from = typeof s.from === 'string' ? collection(entityOf(s.from)) : typeof s.from === 'object' ? COMPUTED : LITERAL
      const joined = Array.isArray(s.pipeline) ? pipeline(s.pipeline as Document[], from, entityOf) : from
      return doc(current, [[String(s.as), joined]])
    }
    case '$graphLookup': {
      const s = spec as Document
      const entries: [string, Shape][] = [[String(s.as), collection(entityOf(String(s.from)))]]
      if (typeof s.depthField === 'string') entries.push([s.depthField, COMPUTED])
      return doc(current, entries)
    }
    case '$unionWith': {
      const s = typeof spec === 'string' ? { coll: spec } : (spec as Document)
      const other = typeof s.coll === 'string' ? collection(entityOf(s.coll)) : LITERAL
      return either([current, Array.isArray(s.pipeline) ? pipeline(s.pipeline as Document[], other, entityOf) : other])
    }
    case '$geoNear': {
      const s = spec as Document
      const entries: [string, Shape][] = []
      if (typeof s.distanceField === 'string') entries.push([s.distanceField, COMPUTED])
      if (typeof s.includeLocs === 'string') entries.push([s.includeLocs, at(current, String(s.key ?? ''))])
      return doc(current, entries)
    }
    case '$setWindowFields':
      return doc(current, Object.entries(((spec as Document).output ?? {}) as Document).map(([k, v]) => [k, accumulator(v, current)]))
    // Documents made or filled among real ones: those fields cannot be told apart, and are computed.
    case '$densify':
      return doc(current, [[String((spec as Document).field), COMPUTED]])
    case '$fill':
      return doc(current, Object.keys(((spec as Document).output ?? {}) as Document).map((k) => [k, COMPUTED]))
    case '$documents':
      return LITERAL
    // Statistics and the schema: sizes, counts and index definitions, no value of a document.
    case '$collStats':
    case '$indexStats':
    case '$listSearchIndexes':
      return LITERAL
    default:
      return COMPUTED
  }
}
