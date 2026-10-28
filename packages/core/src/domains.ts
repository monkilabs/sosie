import { FORMATS, formatByName, PERSONAL, type Format } from './fake/formats.js'
import type { Rules } from './rules.js'
import type { Entity, Field, FieldType, Schema } from './source.js'

/** How a field's values are faked. */
export interface FieldPlan {
  /** The set of real values that share fakes; null when the field passes. */
  domain: string | null
  format?: Format
  /** Whether a fake names one real value in its domain. */
  unique: boolean
  /** The type fakes are drawn for: a foreign key's fakes are drawn as its key's. */
  type?: FieldType
}

const PASS: FieldPlan = { domain: null, unique: false }

/**
 * Which domain each field's values fake in:
 * 1. listed under `pass`: none, the value passes;
 * 2. it shares another field's values: that field's domain, so orders.user_id fakes like users.id;
 * 3. its format is personal: the format's domain, so one person's email is one fake everywhere;
 * 4. otherwise its own id.
 * Fields a source learns as values come (an API without a schema) are planned the same way, when first met.
 */
export function planner(schema: Schema, rules: Rules): (field: Field) => FieldPlan {
  const known = new Map<string, { field: Field; entity: Entity }>()
  for (const entity of schema.entities) for (const field of entity.fields) known.set(field.id, { field, entity })
  const entityOf = (id: string) => id.slice(0, id.lastIndexOf('.'))
  const passes = (id: string) => rules.pass.has(id) || rules.pass.has(`${entityOf(id)}.*`)

  const plans = new Map<string, FieldPlan>()
  const resolve = (field: Field, entity: Pick<Entity, 'name'>, seen: Set<string>, learned: boolean): FieldPlan => {
    const cached = plans.get(field.id)
    if (cached) return cached
    let plan: FieldPlan
    if (passes(field.id)) plan = PASS
    else if (field.references && !seen.has(field.references)) {
      const target = known.get(field.references)
      plan = target
        ? resolve(target.field, target.entity, new Set(seen).add(field.id), false)
        : passes(field.references)
          ? PASS
          : { domain: field.references, unique: true }
      // A guess from a name may be wrong: it never lets a value pass.
      if (field.guessed && plan.domain === null) plan = { domain: field.references, unique: true }
    } else {
      const given = field.format && (FORMATS as readonly string[]).includes(field.format) ? (field.format as Format) : undefined
      const format = rules.format.get(field.id) ?? given ?? (field.type.kind === 'string' ? formatByName(field, entity) : undefined)
      const unique = !!field.key || !!field.references || field.type.kind === 'string' || field.type.kind === 'uuid'
      plan =
        format && PERSONAL.has(format)
          ? { domain: `format:${format}`, format, unique: true }
          : // A learned field may hold another type next time: its fakes are drawn for the value's own type.
            { domain: field.id, unique, ...(!learned && { type: field.type }), ...(format && { format }) }
    }
    plans.set(field.id, plan)
    return plan
  }
  for (const { field, entity } of known.values()) resolve(field, entity, new Set([field.id]), false)
  return (field) => plans.get(field.id) ?? resolve(field, { name: entityOf(field.id) }, new Set([field.id]), true)
}

/** The plan of every field in the schema. */
export function planFields(schema: Schema, rules: Rules): Map<string, FieldPlan> {
  const plan = planner(schema, rules)
  return new Map(schema.entities.flatMap((e) => e.fields.map((f) => [f.id, plan(f)] as const)))
}
