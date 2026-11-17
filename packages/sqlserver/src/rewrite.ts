import type { RequestScope } from '@sosie/core'
import type { ConstRef } from './guard.js'

/** One literal Sosie put in place of the client's text: where it is in the client's text, and how long what replaced it is. */
export interface Edit {
  start: number
  end: number
  length: number
}

/** A place in the client's text, and the literal that goes there: a fake turned back. */
export interface Substitution {
  start: number
  end: number
  literal: string
}

/** The literals each fake compared with a column turns back into, in the client's own quoting (N'…' stays N'…'). */
export function constSubstitutions(consts: readonly ConstRef[], scope: RequestScope): Substitution[] {
  const out: Substitution[] = []
  for (const ref of consts) {
    if (ref.near === 'catalog') continue
    const real = scope.lookup(ref.value, ref.near)
    if (real === undefined || real === ref.value) continue
    out.push({ start: ref.start, end: ref.end, literal: ref.kind === 'number' && /^-?\d+(\.\d+)?$/.test(real) ? real : quote(real, ref.national) })
  }
  return out
}

/** The text with each substitution made, and where each is; undefined when there are none. */
export function substitute(text: string, substitutions: readonly Substitution[]): { sql: string; edits: Edit[] } | undefined {
  if (!substitutions.length) return undefined
  const sorted = [...substitutions].sort((a, b) => a.start - b.start)
  let sql = ''
  let at = 0
  const edits: Edit[] = []
  for (const s of sorted) {
    if (s.start < at) continue
    sql += text.slice(at, s.start) + s.literal
    edits.push({ start: s.start, end: s.end, length: s.literal.length })
    at = s.end
  }
  return { sql: sql + text.slice(at), edits }
}

/** Where a place in the statement sent upstream is in the client's text: inside a literal Sosie put there, the literal's start. */
export function inClientText(at: number, edits: readonly Edit[]): number {
  let shift = 0
  for (const edit of edits) {
    const start = edit.start + shift
    if (at < start) break
    if (at < start + edit.length) return edit.start
    shift += edit.length - (edit.end - edit.start)
  }
  return at - shift
}

/**
 * A string literal as T-SQL reads it: quotes doubled, nothing escaped by a backslash. N'…' where the client wrote
 * one, or where the value holds a character no code page may have.
 */
export function quote(value: string, national = false): string {
  const n = national || /[^\x00-\x7f]/.test(value) ? 'N' : ''
  return `${n}'${value.replace(/'/g, "''")}'`
}
