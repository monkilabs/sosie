import type { RequestScope } from '@sosie/core'
import type { ConstRef } from './guard.js'

/** One literal Sosie turned back: where it is in the client's text, and how long what replaced it is. */
export interface Edit {
  start: number
  end: number
  length: number
}

/**
 * Turn each fake a statement compares with a column back into its real value, where it is in the text: the rest
 * of the statement goes upstream exactly as the client wrote it. Undefined when nothing changed.
 */
export function rewriteConsts(text: string, consts: ConstRef[], scope: RequestScope): { sql: string; edits: Edit[] } | undefined {
  let sql = text
  const edits: Edit[] = []
  for (const ref of [...consts].sort((a, b) => b.start - a.start)) {
    if (ref.near === 'catalog') continue
    const real = scope.lookup(ref.value, ref.near)
    if (real === undefined || real === ref.value) continue
    const literal = ref.kind === 'number' && /^-?\d+(\.\d+)?$/.test(real) ? real : quote(real)
    sql = sql.slice(0, ref.start) + literal + sql.slice(ref.end)
    edits.unshift({ start: ref.start, end: ref.end, length: literal.length })
  }
  return edits.length ? { sql, edits } : undefined
}

/**
 * Where a place in the statement sent upstream is in the client's text: inside a literal Sosie put there, the
 * literal's start.
 */
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

/** A string literal as MySQL reads it with backslash escapes, which Sosie keeps on. */
export function quote(value: string): string {
  return `'${value.replace(/[\\'\0\n\r\x1a]/g, (ch) => ({ '\\': '\\\\', "'": "\\'", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' })[ch]!)}'`
}
