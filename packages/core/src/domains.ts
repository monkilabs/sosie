import { formatByName, PERSONAL, type Format } from './fake/formats.js'
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
 */
export function planFields(schema: Schema, rules: Rules): Map<string, FieldPlan> {
  const fields = new Map<string, { field: Field; entity: Entity }>()
  for (const entity of schema.entities) for (const field of entity.fields) fields.set(field.id, { field, entity })

  const plans = new Map<string, FieldPlan>()
  const resolve = (id: string, seen: Set<string>): FieldPlan => {
    const known = plans.get(id)
    if (known) return known
    const entry = fields.get(id)
    if (!entry) return PASS
    const { field, entity } = entry
    let plan: FieldPlan
    if (rules.pass.has(id)) plan = PASS
    else if (field.references && fields.has(field.references) && !seen.has(field.references)) {
      plan = resolve(field.references, new Set(seen).add(id))
    } else {
      const format = rules.format.get(id) ?? (field.type.kind === 'string' ? formatByName(field, entity) : undefined)
      const unique = !!field.key || !!field.references || field.type.kind === 'string' || field.type.kind === 'uuid'
      plan =
        format && PERSONAL.has(format)
          ? { domain: `format:${format}`, format, unique: true }
          : { domain: id, unique, type: field.type, ...(format && { format }) }
    }
    plans.set(id, plan)
    return plan
  }
  for (const id of fields.keys()) resolve(id, new Set([id]))
  return plans
}
