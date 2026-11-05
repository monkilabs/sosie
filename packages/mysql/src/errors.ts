import type { RequestScope } from '@sosie/core'
import { inClientText, inClientTextEnd, type Edit } from './rewrite.js'
import type { Catalog } from './schema.js'

/** A statement as the client wrote it, as Sosie sent it upstream, and the scope its fakes were turned back in. */
export interface Sent {
  text: string
  sql: string
  edits: readonly Edit[]
  scope: RequestScope
}

/** Errors whose messages hold only what the client wrote and the schema: shown, with what Sosie substituted turned back. */
export const SCHEMA_ERRORS: ReadonlySet<number> = new Set([
  1044, 1045, 1046, 1049, 1051, 1052, 1054, 1060, 1064, 1065, 1109, 1142, 1143, 1146, 1149, 1222, 1227, 1235, 1248, 1250, 1267, 1271,
  1295, 1305, 1317, 1356, 1370, 1449, 1630, 1792, 3024,
])

const PARSE_ERROR = 1064

/** MySQL's syntax error quotes the statement from where it stopped reading, at most 80 characters of it. */
const NEAR = /^([\s\S]*?) near '([\s\S]*)' at line \d+$/

/** What MySQL itself puts in quotes in the messages Sosie shows. */
const PHRASES = new Set(
  [
    'field list', 'where clause', 'on clause', 'order clause', 'group statement', 'having clause', 'from clause', 'IN/ALL/ANY subquery',
    'window partition by', 'window order by', 'global ORDER clause', 'Function Name Parsing and Resolution',
  ].map((p) => p.toLowerCase()),
)

/**
 * What MySQL said, for the client. An error about the statement and the schema is shown, with what Sosie
 * substituted turned back; any other error, by its code only.
 *
 * Two things more keep a value from a row out of what is shown. A quote of the statement (a syntax error's
 * `near '…'`) is taken from the client's own text, at the same place: MySQL's quote of what Sosie sent may cut a
 * real value short, and a part of one is not turned back. And anything else in single quotes that the client did
 * not write, and that names nothing in the schema, is hidden.
 */
export function scrubbed(code: number, message: string, sent: Sent, catalog: Catalog): string {
  if (!SCHEMA_ERRORS.has(code)) return `Error ${code}: Sosie hides the rest of this message, which may quote a value from your rows.`
  const near = code === PARSE_ERROR ? NEAR.exec(message) : null
  const shown = masked(sent.scope.scrub(near ? near[1]! : message), sent.text, catalog)
  if (!near) return shown
  const from = located(near[2]!, sent)
  if (from === undefined) return `${shown} near '…'`
  const line = sent.text.slice(0, from).split('\n').length
  return `${shown} near '${[...sent.text.slice(from)].slice(0, 80).join('')}' at line ${line}`
}

/**
 * A result column's name, for the client. MySQL names a computed column by its text as Sosie sent it, a derived
 * table's or a CTE's in its org_name too, at most 255 characters: with a real value in it where Sosie put one. The
 * name is taken from the client's own text, at the same place, so a literal Sosie put there reads as the client
 * wrote it (a parameter's, as ?, as MySQL names it in a prepared statement). A name not found in what Sosie sent
 * is scrubbed of what was turned back, and anything quoted in it that the client did not write is hidden.
 */
export function columnName(name: string, sent: Sent, catalog: Catalog): string {
  if (!name || !sent.edits.length || sent.text.includes(name)) return name
  const at = sent.sql.indexOf(name)
  if (at < 0) return masked(sent.scope.scrub(name), sent.text, catalog)
  const start = inClientText(at, sent.edits)
  const end = inClientTextEnd(at + name.length, sent.edits)
  return [...sent.text.slice(start, end)].slice(0, 255).join('')
}

/** Where in the client's text MySQL's quote of the statement Sosie sent starts. */
function located(fragment: string, sent: Sent): number | undefined {
  // A quote cut inside a character ends in a replacement character.
  const quote = fragment.replace(/�+$/, '')
  const at = sent.sql.endsWith(quote) ? sent.sql.length - quote.length : sent.sql.indexOf(quote)
  return at < 0 ? undefined : inClientText(at, sent.edits)
}

/**
 * Single quotes open and close at a word's edge: the apostrophe of MySQL's own "doesn't" opens nothing, and that
 * of a value such as O'Brien is in it. A net under the list of errors shown, not the guarantee: a value can hold
 * quotes no pattern pairs.
 */
const QUOTED = /(?<!\w)'((?:[^']|(?<=\w)'(?=\w))*)'(?!\w)/g

function masked(message: string, text: string, catalog: Catalog): string {
  return message.replace(QUOTED, (whole, inner: string) => (known(inner, text, catalog) ? whole : "'…'"))
}

/** Text the client wrote, MySQL's own words, or a name, each of its dotted parts written or in the schema. */
function known(inner: string, text: string, catalog: Catalog): boolean {
  if (inner === '' || written(text, inner) || PHRASES.has(inner.toLowerCase())) return true
  const schema = names(catalog)
  return inner.split('.').every((part) => part !== '' && (written(text, part) || schema.has(part.toLowerCase())))
}

/** The token is in the text, not inside a longer word. */
function written(text: string, token: string): boolean {
  const haystack = text.toLowerCase()
  const needle = token.toLowerCase()
  const word = /\w/
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1]
    const after = haystack[at + needle.length]
    const open = !before || !word.test(before) || !word.test(needle[0]!)
    const close = !after || !word.test(after) || !word.test(needle.at(-1)!)
    if (open && close) return true
  }
  return false
}

const named = new WeakMap<Catalog, Set<string>>()

/** Every database, table and column name in the catalog, lowercased. */
function names(catalog: Catalog): Set<string> {
  let set = named.get(catalog)
  if (!set) {
    set = new Set([catalog.database.toLowerCase()])
    for (const key of [...catalog.relations.keys(), ...catalog.columns.keys()]) for (const part of key.split('.')) set.add(part.toLowerCase())
    named.set(catalog, set)
  }
  return set
}
