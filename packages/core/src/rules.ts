import { parse } from 'yaml'
import { FORMATS, type Format } from './fake/formats.js'
import type { Field, Schema } from './source.js'

/** sosie.yml, checked against the neutral schema. */
export interface Rules {
  /** Ids of the fields whose values pass unchanged. */
  pass: Set<string>
  /** Formats for fields Sosie cannot tell from their names. */
  format: Map<string, Format>
  /** Fields not met yet, for a source that learns its fields: kept, and worth a look. */
  warnings: string[]
}

export class RulesError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'))
    this.name = 'RulesError'
  }
}

export const NO_RULES: Rules = { pass: new Set(), format: new Map(), warnings: [] }

/** Rules as one part of sosie.yml writes them, the top's or a source's: not yet checked. */
export interface RuleSet {
  pass?: unknown
  format?: unknown
}

export interface RulesFor {
  /** The source's own rules: each must name its fields. */
  own?: RuleSet
  /** The top's rules, for every source: each holds where its table or collection exists. */
  shared?: RuleSet
  /** For messages. */
  file?: string
  /** The source's name, for messages: `sources.shop: …`. */
  source?: string
  /** The source learns its fields as values come: a field not met yet is kept. */
  learns?: boolean
}

/** The rules one source holds to, and which of the top's it holds (`applied`), so that one no source holds is told. */
export type SourceRules = Rules & { applied: Set<string> }

/**
 * A source's rules, checked against its schema; every problem at once, each naming what is wrong. Its own rules must
 * name its fields; the top's hold where their table exists and must name a field there. For a source that `learns`
 * its fields, a field not met yet is kept: its own with a warning, the top's quietly.
 */
export function rulesFor(schema: Schema, { own, shared, file = 'sosie.yml', source, learns = false }: RulesFor): SourceRules {
  const problems: string[] = []
  const fields = new Map<string, Field>()
  for (const entity of schema.entities) for (const field of entity.fields) fields.set(field.id, field)
  const entities = new Map(schema.entities.map((e) => [e.id, e]))
  const rules: SourceRules = { pass: new Set(), format: new Map(), warnings: [], applied: new Set() }

  /** Why an id names nothing here, without the file's name. */
  const unknownField = (id: string, shared: boolean) => {
    const entityId = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : id
    if (!id.includes('.') || !entities.has(entityId)) {
      const hint = suggest(entityId || id, [...entities.keys()])
      return `${entityId || id} is not a table.${hint ? ` Did you mean ${hint}?` : ''}`
    }
    const hint = suggest(id, entities.get(entityId)!.fields.map((f) => f.id))
    const of = shared && source ? ` of ${source}'s ${entityId}` : ''
    return `${id} is not a field${of}.${hint ? ` Did you mean ${hint}?` : ''}${shared && source ? ' A rule for one source goes under it.' : ''}`
  }
  const where = (shared: boolean) => (shared || !source ? `${file}:` : `${file}: sources.${source}:`)

  /** A rule that names nothing here: an error, kept for a source that learns, or for the top's, another source's. */
  const unknown = (id: string, shared: boolean, keep: () => void) => {
    // Values that name no entity, and Sosie's own words for the API's ($path, $query), are no rule's to pass.
    if (id.startsWith('*.') || id.startsWith('$')) {
      return problems.push(`${where(shared)} ${id} names no entity; a rule names an entity's field, such as orders.status.`)
    }
    const entityId = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : id
    if (shared && !learns && (!id.includes('.') || !entities.has(entityId))) return // Another source's.
    if (!learns) return problems.push(`${where(shared)} ${unknownField(id, shared)}`)
    keep()
    if (!shared) rules.warnings.push(`${where(false)} ${unknownField(id, false).replace(/ is not a (table|field)\./, ' is not known yet:')} it applies once Sosie meets it.`)
    return true
  }

  const check = (set: RuleSet | undefined, shared: boolean) => {
    if (!set) return
    if (set.pass !== undefined) {
      if (!Array.isArray(set.pass) || set.pass.some((v) => typeof v !== 'string')) {
        problems.push(`${where(shared)} pass is a list of fields, such as orders.status or countries.*`)
      } else {
        for (const pattern of set.pass as string[]) {
          if (pattern.endsWith('.*')) {
            const entity = entities.get(pattern.slice(0, -2))
            if (!entity) {
              if (unknown(`${pattern.slice(0, -2)}.*`, shared, () => rules.pass.add(pattern)) === true && shared) rules.applied.add(pattern)
            } else {
              for (const field of entity.fields) rules.pass.add(field.id)
              // A source that learns its fields (MongoDB) knows few or none of them yet: the pattern holds for those to come.
              if (learns) rules.pass.add(pattern)
              if (shared) rules.applied.add(pattern)
            }
          } else if (fields.has(pattern)) {
            rules.pass.add(pattern)
            if (shared) rules.applied.add(pattern)
          } else if (unknown(pattern, shared, () => rules.pass.add(pattern)) === true && shared) rules.applied.add(pattern)
        }
      }
    }
    if (set.format !== undefined) {
      if (set.format === null || typeof set.format !== 'object' || Array.isArray(set.format)) {
        problems.push(`${where(shared)} format maps fields to formats, such as users.handle: username`)
        return
      }
      for (const [id, format] of Object.entries(set.format)) {
        if (typeof format !== 'string' || !FORMATS.includes(format as Format)) {
          const hint = typeof format === 'string' ? suggest(format, [...FORMATS]) : undefined
          problems.push(`${where(shared)} ${String(format)} is not a format.${hint ? ` Did you mean ${hint}?` : ''} Formats: ${FORMATS.join(', ')}.`)
        } else if (fields.has(id)) {
          rules.format.set(id, format as Format)
          if (shared) rules.applied.add(`format:${id}`)
        } else if (unknown(id, shared, () => rules.format.set(id, format as Format)) === true && shared) rules.applied.add(`format:${id}`)
      }
    }
  }
  // The top's first, so a source's own format for a field wins.
  check(shared, true)
  const fromTop = new Set(rules.pass)
  check(own, false)

  // A field that shares another's values must pass with it, or joins between them break. Told where its rule is.
  for (const id of rules.pass) {
    const target = fields.get(id)?.references
    if (target && !rules.pass.has(target)) {
      problems.push(`${where(fromTop.has(id))} ${id} passes but ${target}, whose values it shares, does not. List both or neither.`)
    }
  }

  if (problems.length) throw new RulesError(problems)
  return rules
}

/** The top's rules no source held: a typo, or a source missing from sosie.yml. Every one of them, at once. */
export function unheldRules(shared: RuleSet, held: Iterable<Set<string>>, file = 'sosie.yml'): string[] {
  const all = new Set<string>()
  for (const set of held) for (const id of set) all.add(id)
  const problems: string[] = []
  for (const pattern of Array.isArray(shared.pass) ? (shared.pass as unknown[]) : []) {
    if (typeof pattern === 'string' && !all.has(pattern)) problems.push(`${file}: ${pattern.replace(/\.\*$/, '')} is not a table of any source.`)
  }
  if (shared.format && typeof shared.format === 'object' && !Array.isArray(shared.format)) {
    for (const id of Object.keys(shared.format)) if (!all.has(`format:${id}`)) problems.push(`${file}: ${id} is not a field of any source.`)
  }
  return problems
}

/**
 * Parse and check rules alone, as one source holds to them: a file of `pass` and `format` and nothing else. Every
 * problem is reported at once, each naming what is wrong. For a source that `learns` its fields, a field not met yet
 * is kept, with a warning.
 */
export function loadRules(text: string, schema: Schema, file = 'sosie.yml', { learns = false } = {}): Rules {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (error) {
    throw new RulesError([`${file}: ${(error as Error).message.split('\n')[0]}`])
  }
  if (doc == null) return NO_RULES
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new RulesError([`${file}: expected the keys pass and format.`])
  const problems: string[] = []
  for (const key of Object.keys(doc)) {
    if (key === 'pass' || key === 'format') continue
    const hint = suggest(key, ['pass', 'format'])
    problems.push(`${file}: ${key} is not a key.${hint ? ` Did you mean ${hint}?` : ''} Keys: pass, format.`)
  }
  let rules: SourceRules | undefined
  try {
    rules = rulesFor(schema, { own: doc as RuleSet, file, learns })
  } catch (error) {
    if (!(error instanceof RulesError)) throw error
    problems.unshift(...error.problems)
  }
  if (problems.length) throw new RulesError(problems)
  const { applied: _, ...plain } = rules!
  return plain
}

/** The closest candidate, when it is close enough to be a typo. */
export function suggest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const d = distance(input.toLowerCase(), candidate.toLowerCase())
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(input.length / 4)) ? best : undefined
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]!
}
