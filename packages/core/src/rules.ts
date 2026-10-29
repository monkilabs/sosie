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

/**
 * Parse and check sosie.yml. Every problem is reported at once, each naming what is wrong.
 * For a source that `learns` its fields, a field not met yet is kept, with a warning.
 */
export function loadRules(text: string, schema: Schema, file = 'sosie.yml', { learns = false } = {}): Rules {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (error) {
    throw new RulesError([`${file}: ${(error as Error).message.split('\n')[0]}`])
  }
  if (doc == null) return NO_RULES
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new RulesError([`${file}: expected the keys pass and format.`])
  }

  const problems: string[] = []
  const fields = new Map<string, Field>()
  for (const entity of schema.entities) for (const field of entity.fields) fields.set(field.id, field)
  const entities = new Map(schema.entities.map((e) => [e.id, e]))

  const unknownField = (id: string) => {
    const entityId = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : id
    if (!id.includes('.') || !entities.has(entityId)) {
      const hint = suggest(entityId || id, [...entities.keys()])
      return `${file}: ${entityId || id} is not a table.${hint ? ` Did you mean ${hint}?` : ''}`
    }
    const hint = suggest(id, entities.get(entityId)!.fields.map((f) => f.id))
    return `${file}: ${id} is not a field.${hint ? ` Did you mean ${hint}?` : ''}`
  }

  const rules: Rules = { pass: new Set(), format: new Map(), warnings: [] }
  const unknown = (id: string, keep: () => void) => {
    // Values that name no entity, and Sosie's own words for the API's ($path, $query), are no rule's to pass.
    if (id.startsWith('*.') || id.startsWith('$')) return problems.push(`${file}: ${id} names no entity; a rule names an entity's field, such as orders.status.`)
    if (!learns) return problems.push(unknownField(id))
    keep()
    rules.warnings.push(`${unknownField(id).replace(/ is not a (table|field)\./, ' is not known yet:')} it applies once Sosie meets it.`)
  }
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'pass') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        problems.push(`${file}: pass is a list of fields, such as orders.status or countries.*`)
        continue
      }
      for (const pattern of value as string[]) {
        if (pattern.endsWith('.*')) {
          const entity = entities.get(pattern.slice(0, -2))
          if (!entity) unknown(`${pattern.slice(0, -2)}.*`, () => rules.pass.add(pattern))
          else for (const field of entity.fields) rules.pass.add(field.id)
        } else if (fields.has(pattern)) {
          rules.pass.add(pattern)
        } else {
          unknown(pattern, () => rules.pass.add(pattern))
        }
      }
    } else if (key === 'format') {
      if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${file}: format maps fields to formats, such as users.handle: username`)
        continue
      }
      for (const [id, format] of Object.entries(value)) {
        if (typeof format !== 'string' || !FORMATS.includes(format as Format)) {
          const hint = typeof format === 'string' ? suggest(format, [...FORMATS]) : undefined
          problems.push(
            `${file}: ${String(format)} is not a format.${hint ? ` Did you mean ${hint}?` : ''} Formats: ${FORMATS.join(', ')}.`,
          )
        } else if (!fields.has(id)) unknown(id, () => rules.format.set(id, format as Format))
        else rules.format.set(id, format as Format)
      }
    } else {
      const hint = suggest(key, ['pass', 'format'])
      problems.push(`${file}: ${key} is not a key.${hint ? ` Did you mean ${hint}?` : ''} Keys: pass, format.`)
    }
  }

  // A field that shares another's values must pass with it, or joins between them break.
  for (const id of rules.pass) {
    const target = fields.get(id)?.references
    if (target && !rules.pass.has(target)) {
      problems.push(`${file}: ${id} passes but ${target}, whose values it shares, does not. List both or neither.`)
    }
  }

  if (problems.length) throw new RulesError(problems)
  return rules
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
