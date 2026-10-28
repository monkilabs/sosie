import type { Entity } from './source.js'

/**
 * How sources without foreign keys tell which field shares another's values:
 * by name, as APIs name them. A wrong guess fakes two fields alike or apart;
 * it never lets a value pass that sosie.yml does not.
 */

/** 'users' to 'user', 'categories' to 'category', 'addresses' to 'address'. */
export function singular(word: string): string {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (/[^su]s$/.test(word) && !/is$/.test(word) && word.length > 3) return word.slice(0, -1)
  return word
}

/** The entity a key like `userId`, `user_id` or `userIds` refers to, by name. */
export function referenceOf<T>(key: string, find: (name: string) => T | undefined): T | undefined {
  const m = /^(.+?)(?:Id|_id|Ids|_ids)$/.exec(key)
  return m ? find(singular(m[1]!.toLowerCase())) : undefined
}

/** A field named like `userId` or `user_id` shares the values of the id of the entity it names. */
export function linkByName(entities: Entity[]): void {
  const byName = new Map(entities.map((e) => [singular(e.name.toLowerCase()), e]))
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.references) continue
      const target = referenceOf(field.name, (name) => byName.get(name))
      if (target && target.id !== entity.id && target.fields.some((f) => f.id === `${target.id}.id`)) {
        field.references = `${target.id}.id`
        field.guessed = true
      }
    }
  }
}

/**
 * SOSIE_UPSTREAM_HEADERS: one `Name: value` per line, for the credentials an HTTP upstream wants.
 * A line that is no valid header is refused by its number, never quoted: it may hold a secret.
 */
export function upstreamHeaders(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  ;(text ?? '').split(/\r?\n|\\n/).forEach((line, i) => {
    const at = line.indexOf(':')
    if (!line.trim()) return
    const name = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    try {
      if (at <= 0) throw new Error()
      new Headers([[name, value]])
    } catch {
      throw new Error(`SOSIE_UPSTREAM_HEADERS: line ${i + 1} is not a header. Write one Name: value per line.`)
    }
    headers[name] = value
  })
  return headers
}
