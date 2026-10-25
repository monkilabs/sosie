import type { RequestScope } from '@sosie/core'
import { deparseSync } from 'pgsql-parser'
import { parseArray, serializeArray } from './arrays.js'
import { constValue, type Analysis, type Near, type ParamRef } from './guard.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the parse tree is Postgres's own, untyped here. */
type Node = Record<string, any>

/**
 * Turn each fake a statement compares with a column back into its real value,
 * in place. Returns whether anything changed, so an unchanged statement goes
 * upstream exactly as the client wrote it.
 */
export function rewriteConsts(analysis: Analysis, scope: RequestScope): boolean {
  let changed = false
  for (const { node, near, array } of analysis.consts) {
    const value = constValue(node)
    if (value === undefined) continue
    if (array) {
      if (typeof value !== 'string') continue
      const real = lookupArray(value, near, scope)
      if (real !== undefined) {
        replace(node, real, 'string')
        changed = true
      }
      continue
    }
    if (typeof value === 'boolean' && (!near || near === 'catalog' || near.type.kind !== 'boolean')) continue
    const real = lookup(String(value), near, scope)
    if (real !== undefined && real !== String(value)) {
      replace(node, real, typeof value)
      changed = true
    }
  }
  return changed
}

/** The text a Bind parameter carries, with a fake turned back into its real value. */
export function rewriteParam(text: string, ref: ParamRef | undefined, scope: RequestScope): string {
  if (!ref || ref.near === 'catalog') return text
  if (ref.array) return lookupArray(text, ref.near, scope) ?? text
  return lookup(text, ref.near, scope) ?? text
}

/** The statement as SQL again. */
export function print(stmt: Node): string {
  return deparseSync(stmt)
}

function lookup(text: string, near: Near, scope: RequestScope): string | undefined {
  if (near === 'catalog') return undefined
  return scope.lookup(text, near)
}

function lookupArray(text: string, near: Near, scope: RequestScope): string | undefined {
  if (near === 'catalog') return undefined
  let parsed
  try {
    parsed = parseArray(text)
  } catch {
    return undefined
  }
  let changed = false
  const element = near && near.type.kind === 'array' ? { ...near, type: near.type.of } : near
  const items = parsed.items.map((item) => {
    if (typeof item !== 'string') return item
    const real = scope.lookup(item, element)
    if (real === undefined) return item
    changed = true
    return real
  })
  return changed ? serializeArray(items, parsed.bounds) : undefined
}

function replace(node: Node, real: string, kind: string): void {
  const location = node.location
  for (const key of ['sval', 'ival', 'fval', 'boolval']) delete node[key]
  if (kind === 'boolean') node.boolval = { boolval: /^(t|true|y|yes|on|1)$/i.test(real) }
  else if (kind === 'number' && /^-?\d+$/.test(real) && Math.abs(Number(real)) <= 2147483647) node.ival = { ival: Number(real) }
  else if (kind !== 'string' && /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(real)) node.fval = { fval: real }
  else node.sval = { sval: real }
  if (location !== undefined) node.location = location
}
