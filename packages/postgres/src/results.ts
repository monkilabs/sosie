import type { Faker, Field, FieldType, Value } from '@sosie/core'
import { parseArray, serializeArray } from './arrays.js'
import type { Analysis, Target } from './guard.js'
import type { ColumnDescription } from './protocol.js'
import { typeByOid, type Catalog } from './schema.js'

/** How one result column is faked. */
export type ColumnPlan = { pass: true } | { field: Field } | { type: FieldType }

/** Objects initdb creates have OIDs below this: the catalogs and information_schema. */
const FIRST_NORMAL_OID = 16384
const INT8 = 20

/**
 * Which field each result column came from. Postgres reports each column's
 * table and position, even through SELECT *, aliases, joins, subqueries and
 * views; a column it cannot place was computed, and is faked by its type.
 */
export function planColumns(columns: ColumnDescription[], analysis: Analysis, catalog: Catalog): ColumnPlan[] {
  const targets = expand(analysis.targets, columns.length)
  return columns.map((column, i): ColumnPlan => {
    // A column Postgres says came from a table Sosie knows is faked, whatever the guard decided.
    const field = column.tableID ? catalog.columns.get(`${column.tableID}:${column.columnID}`) : undefined
    if (field) return { field }
    // A system catalog's column passes. Any other table Postgres names is one Sosie does not know: faked by type.
    if (column.tableID) return column.tableID < FIRST_NORMAL_OID ? { pass: true } : { type: typeByOid(column.dataTypeID, catalog.enums) }
    if (analysis.catalogOnly) return { pass: true }
    const target = targets?.[i]
    // count(…) holds no value from a row: a bigint, from Postgres's own count.
    if (target === 'count' && column.dataTypeID === INT8) return { pass: true }
    if (typeof target === 'object') return { field: target }
    return { type: typeByOid(column.dataTypeID, catalog.enums) }
  })
}

/** The select list matched to result columns; one * may stand for several. */
function expand(targets: Target[] | undefined, count: number): Target[] | undefined {
  if (!targets) return undefined
  const stars = targets.filter((t) => t === 'star').length
  if (stars === 0) return targets.length === count ? targets : undefined
  if (stars > 1) return undefined
  const at = targets.indexOf('star')
  const width = count - (targets.length - 1)
  if (width < 0) return undefined
  return [...targets.slice(0, at), ...Array<Target>(width).fill('star'), ...targets.slice(at + 1)]
}

/** One row of text values, faked column by column. */
export function fakeRow(values: (string | null)[], plans: ColumnPlan[], faker: Faker, sent = ''): (string | null)[] {
  return values.map((value, i) => {
    const plan = plans[i]
    if (value === null || !plan || 'pass' in plan) return value
    const type = 'field' in plan ? plan.field.type : plan.type
    const fake = (v: Value) => ('field' in plan ? faker.value(v, plan.field) : faker.computed(v, plan.type, sent))
    if (type.kind === 'array') {
      try {
        const { bounds, items } = parseArray(value)
        return serializeArray(fake(items) as Value[], bounds)
      } catch {
        return faker.computed(value, { kind: 'string' }, sent) as string
      }
    }
    return fake(value) as string | null
  })
}
