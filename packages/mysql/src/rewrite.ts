import type { RequestScope } from '@sosie/core'
import type { ConstRef } from './guard.js'

/**
 * Turn each fake a statement compares with a column back into its real value, where it is in the text: the rest
 * of the statement goes upstream exactly as the client wrote it. Undefined when nothing changed.
 */
export function rewriteConsts(text: string, consts: ConstRef[], scope: RequestScope): string | undefined {
  let out = text
  let changed = false
  for (const ref of [...consts].sort((a, b) => b.start - a.start)) {
    if (ref.near === 'catalog') continue
    const real = scope.lookup(ref.value, ref.near)
    if (real === undefined || real === ref.value) continue
    const literal = ref.kind === 'number' && /^-?\d+(\.\d+)?$/.test(real) ? real : quote(real)
    out = out.slice(0, ref.start) + literal + out.slice(ref.end)
    changed = true
  }
  return changed ? out : undefined
}

/** A string literal as MySQL reads it with backslash escapes, which Sosie keeps on. */
export function quote(value: string): string {
  return `'${value.replace(/[\\'\0\n\r\x1a]/g, (ch) => ({ '\\': '\\\\', "'": "\\'", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' })[ch]!)}'`
}
