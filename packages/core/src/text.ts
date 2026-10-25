/** How values and transcripts are compared by `sosie scan`: case, punctuation and spacing do not matter. */

const SEPARATORS = /[^\p{L}\p{N}@._+'-]+/u
const EDGES = /^[.'_+-]+|[.'_+-]+$/g

/** The words of a text, lower-cased, without punctuation around them. */
export function tokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(SEPARATORS)
    .map((t) => t.replace(EDGES, ''))
    .filter(Boolean)
}

/** One form for every spelling of the same value: 'Kim  NOVAK.' and 'kim novak' are both 'kim novak'. */
export function normalize(text: string): string {
  return tokens(text).join(' ')
}

/** Most words a scanned value may have. */
export const MAX_WORDS = 4

/**
 * Whether a real value is distinctive enough to look for in transcripts: one
 * to four words of at least four characters, and numbers of six digits or
 * more, so years, ports and line numbers do not count as findings.
 */
export function distinctive(text: string): boolean {
  const words = tokens(text)
  if (words.length < 1 || words.length > MAX_WORDS) return false
  const joined = words.join(' ')
  if (joined.length < 4) return false
  if (/^[\d.,: -]+$/.test(joined)) return joined.replace(/\D/g, '').length >= 6
  return true
}
