import type { Faker, Field, FieldType, RequestScope, Value } from '@sosie/core'
import type { Analysis, Target } from './guard.js'
import type { Column } from './protocol.js'
import { SYSTEM_DATABASES, typeOfColumn, type Catalog } from './schema.js'

/** How one result column is faked. */
export type ColumnPlan = { pass: true } | { field: Field } | { type: FieldType }

/**
 * Which field each result column came from. MySQL names each column's database, table and column, through
 * aliases, joins and views; a column it cannot place was computed, and is faked by its type. Whether a value is
 * faked rests on what MySQL says, not on how Sosie read the statement.
 */
export function planColumns(columns: Column[], analysis: Analysis, catalog: Catalog): ColumnPlan[] {
  // SHOW and DESCRIBE show the schema, from MySQL's data dictionary: nothing in them is a row's value.
  if (analysis.answer === 'schema') return columns.map(() => ({ pass: true }))
  const targets = expand(analysis.targets, columns.length)
  // A column from a table of yours says the statement read data, whatever the guard made of it.
  const data = !analysis.catalogOnly || columns.some((c) => c.orgTable && c.schema && !SYSTEM_DATABASES.has(c.schema.toLowerCase()))
  return columns.map((column, i): ColumnPlan => {
    if (column.orgTable) {
      const field = catalog.columns.get(`${column.schema}.${column.orgTable}.${column.orgName}`.toLowerCase())
      if (field) return { field }
      // MySQL's own catalog passes, and its data dictionary (a table with no database) in a statement that reads only
      // the catalog; a table Sosie does not know (made since it started) is faked by type.
      if (SYSTEM_DATABASES.has(column.schema.toLowerCase()) || (!column.schema && !data)) return { pass: true }
      return { type: typeOfColumn(column.type, column.characterSet, column.flags, column.length) }
    }
    if (!data) return { pass: true }
    const target = targets?.[i]
    // count(…) holds no value from a row: a BIGINT, from MySQL's own count. Nor does a literal the client wrote.
    if (target === 'count' && column.type === 8) return { pass: true }
    if (target === 'constant') return { pass: true }
    return { type: typeOfColumn(column.type, column.characterSet, column.flags, column.length) }
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

/** One row of the text protocol, faked column by column: text as text, bytes as bytes. */
export function fakeRow(values: (Buffer | null)[], plans: ColumnPlan[], faker: Faker, sent = '', scope?: RequestScope): (Buffer | null)[] {
  return values.map((value, i) => {
    const plan = plans[i]
    if (value === null || !plan || 'pass' in plan) return value
    const type = 'field' in plan ? plan.field.type : plan.type
    const bytes = type.kind === 'bytes'
    // The core fakes bytes in their hex text form, as Postgres writes them.
    const text = bytes ? `\\x${value.toString('hex')}` : value.toString('utf8')
    const fake = ('field' in plan ? faker.value(text, plan.field, scope) : faker.computed(text, plan.type, sent, scope)) as Value
    if (fake === null) return null
    const out = String(fake)
    return bytes ? Buffer.from(out.replace(/^\\x/, ''), 'hex') : Buffer.from(out, 'utf8')
  })
}
