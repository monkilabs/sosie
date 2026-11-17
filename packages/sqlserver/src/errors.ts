import type { RequestScope } from '@sosie/core'
import type { Edit } from './rewrite.js'
import type { Catalog } from './schema.js'

/** A request as the client wrote it, as Sosie sent it upstream, and the scope its fakes were turned back in. */
export interface Sent {
  text: string
  sql: string
  edits: readonly Edit[]
  scope: RequestScope
}

/**
 * Messages that hold only what the client wrote, names, and SQL Server's own words: shown, with what Sosie
 * substituted turned back. Any other is shown by its number only: a conversion's (245: "Conversion failed when
 * converting the nvarchar value 'kim@example.net' to data type int"), a constraint's, a JSON parse's quote a value.
 */
export const SCHEMA_MESSAGES: ReadonlySet<number> = new Set([
  // Syntax, names, and what a statement must declare.
  102, 103, 105, 109, 110, 111, 113, 116, 119, 120, 121, 125, 126, 128, 129, 130, 134, 135, 136, 137, 139, 141, 142, 144, 145, 147,
  148, 149, 153, 155, 156, 157, 158, 160, 164, 166, 167, 168, 169, 170, 171, 173, 174, 177, 178, 179, 180, 181, 183, 189, 195, 197,
  199, 201, 206, 207, 208, 209, 213, 214, 215, 216, 217, 223, 225, 227, 229, 230, 262, 263, 297, 300, 306, 307, 308, 319, 321, 325,
  335, 336, 338, 352, 402, 403, 404, 405, 406, 409, 411, 412, 413, 414, 415, 425, 426, 451, 457, 468, 488, 529, 1001, 1013, 1018,
  1033, 1035, 1038, 1056, 2812, 2809, 4104, 4108, 4109, 4113, 4145, 4147, 4184, 4405, 4406, 4413, 4415, 8101, 8114, 8115, 8116, 8117,
  8118, 8120, 8121, 8124, 8126, 8127, 8134, 8155, 8156, 8178, 10734, 10753, 15009, 15151, 15247,
  // Logins, databases, transactions, locks, and Sosie's own read-only answer.
  911, 916, 4060, 18456, 1205, 1222, 266, 3609, 3621, 3902, 3903, 3906, 3910, 3930, 3998,
  // What a session's settings and statistics print.
  5701, 5703, 8153, 3612, 3613, 3615, 3627,
  // Dates that do not convert, named by type only. An overflow's (220, 232) quotes the value: hidden.
  241, 242,
])

/** What SQL Server itself puts in quotes in the messages Sosie shows. */
const PHRASES = new Set(['nchar', 'nvarchar', 'ntext', 'char', 'varchar', 'text', 'image', 'xml'])

/**
 * What SQL Server said, for the client: a message about the statement and the schema with what Sosie substituted
 * turned back, and anything else in single quotes that the client did not write, and that names nothing in the
 * schema, hidden; any other message, by its number only.
 */
export function scrubbed(number: number, message: string, sent: Sent | undefined, catalog: Catalog): string {
  if (!SCHEMA_MESSAGES.has(number)) return `Message ${number}: Sosie hides the rest of this message, which may quote a value from your rows.`
  if (!sent) return masked(message, '', catalog)
  return masked(sent.scope.scrub(message), sent.text, catalog)
}

/**
 * Single quotes open and close at a word's edge: the apostrophe of a value such as O'Brien is in it. A net under the
 * list of messages shown, not the guarantee: a value can hold quotes no pattern pairs.
 */
const QUOTED = /(?<!\w)'((?:[^']|(?<=\w)'(?=\w))*)'(?!\w)/g

function masked(message: string, text: string, catalog: Catalog): string {
  return message.replace(QUOTED, (whole, inner: string) => (known(inner, text, catalog) ? whole : "'…'"))
}

/** Text the client wrote, SQL Server's own words, or a name, each of its dotted parts written or in the schema. */
function known(inner: string, text: string, catalog: Catalog): boolean {
  if (inner === '' || written(text, inner) || PHRASES.has(inner.toLowerCase())) return true
  const schema = names(catalog)
  return inner.split('.').every((part) => {
    const bare = part.replace(/^\[|\]$/g, '')
    return bare !== '' && (written(text, bare) || schema.has(bare.toLowerCase()))
  })
}

/** The token is in the text, not inside a longer word. */
function written(text: string, token: string): boolean {
  if (!token) return false
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

/** Every database, schema, table and column name in the catalog, lowercased. */
function names(catalog: Catalog): Set<string> {
  let set = named.get(catalog)
  if (!set) {
    set = new Set([catalog.database.toLowerCase(), catalog.defaultSchema.toLowerCase()])
    for (const key of [...catalog.relations.keys(), ...catalog.columns.keys()]) for (const part of key.split('.')) set.add(part.toLowerCase())
    named.set(catalog, set)
  }
  return set
}
