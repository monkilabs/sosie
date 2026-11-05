/**
 * A query of several statements, split where MySQL ends each: at a semicolon outside quotes and comments. Each
 * piece is then parsed, checked and sent upstream on its own, on a session that runs one statement per query, so a
 * piece MySQL would read as two fails there instead of running.
 */
export function splitStatements(text: string): string[] {
  const pieces: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') i = closing(text, i)
    else if (ch === '#' || (ch === '-' && text[i + 1] === '-' && (i + 2 >= text.length || /[\s\x00-\x1f]/.test(text[i + 2]!)))) {
      const end = text.indexOf('\n', i)
      i = end < 0 ? text.length : end
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else if (ch === ';') {
      pieces.push(text.slice(start, i))
      start = i + 1
    }
  }
  pieces.push(text.slice(start))
  return pieces
}

/** Where a quoted string or name that opens at `at` closes: a doubled quote is one quote, and in a string, a backslash escapes. */
function closing(text: string, at: number): number {
  const quote = text[at]!
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\' && quote !== '`') i++
    else if (text[i] === quote) {
      if (text[i + 1] === quote) i++
      else return i
    }
  }
  return text.length
}
