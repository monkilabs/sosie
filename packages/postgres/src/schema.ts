import type { Entity, Field, FieldType, Schema } from '@sosie/core'
import type pg from 'pg'
import { parseSync } from 'pgsql-parser'

/** What the Postgres source knows about the upstream, beyond the neutral schema. */
export interface Catalog {
  schema: Schema
  /** A result column's table OID and column number, to its field. */
  columns: Map<string, Field>
  /** A relation by schema and name, for resolving column references in a query. */
  relations: Map<string, { entity: Entity; byName: Map<string, Field> }>
  /** Labels of each enum type, by type OID: for computed values of an enum type. */
  enums: Map<number, string[]>
  /** Names of functions, operators and types outside the system schemas: their code may read rows the guard cannot see. */
  functions: Set<string>
  operators: Set<string>
  types: Set<string>
  /** Names of every function that returns rows, in any schema: a count of their rows may be a value. */
  setReturning: Set<string>
  /** Names of the system catalogs and information_schema views. */
  system: Set<string>
  /** Tables and views, for the terminal. */
  tables: number
  views: number
  /** Tables the login could write to. */
  writable: number
  /** Whether the login is a superuser or may replicate. */
  admin: boolean
}

export interface RelationRow {
  oid: number
  nspname: string
  relname: string
  relkind: string
  parent: number | null
}

export interface ColumnRow {
  attrelid: number
  attnum: number
  attname: string
  atttypmod: number
  typname: string
  typtype: string
  typcategory: string
  element: string | null
  element_type: string | null
  basetype: string | null
  enumtypid: number | null
}

export interface ConstraintRow {
  conrelid: number
  contype: 'p' | 'u' | 'f'
  conkey: number[]
  confrelid: number
  confkey: number[] | null
}

export interface ViewRow {
  view: number
  definition: string
}

const SYSTEM = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`

/** Read the catalog once, at start-up. */
export async function readCatalog(client: pg.Client): Promise<Catalog> {
  const relations = await client.query<RelationRow>(`
    SELECT c.oid::int AS oid, n.nspname, c.relname, c.relkind,
           (SELECT i.inhparent::int FROM pg_inherits i WHERE i.inhrelid = c.oid AND c.relispartition) AS parent
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${SYSTEM}
    ORDER BY n.nspname, c.relname`)
  const oids = relations.rows.map((r) => r.oid)
  const columns = await client.query<ColumnRow>(
    `
    SELECT a.attrelid::int AS attrelid, a.attnum::int AS attnum, a.attname, a.atttypmod,
           t.typname, t.typtype, t.typcategory,
           e.typname AS element, e.typtype AS element_type,
           b.typname AS basetype,
           CASE WHEN t.typtype = 'e' THEN t.oid::int WHEN e.typtype = 'e' THEN e.oid::int END AS enumtypid
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_type e ON e.oid = t.typelem AND t.typcategory = 'A'
    LEFT JOIN pg_type b ON b.oid = t.typbasetype AND t.typtype = 'd'
    WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum`,
    [oids],
  )
  const constraints = await client.query<ConstraintRow>(
    `SELECT conrelid::int AS conrelid, contype, conkey::int[] AS conkey, confrelid::int AS confrelid, confkey::int[] AS confkey
     FROM pg_constraint WHERE contype IN ('p', 'u', 'f') AND conrelid = ANY($1::oid[])`,
    [oids],
  )
  const enums = await client.query<{ oid: number; labels: string[] }>(
    `SELECT enumtypid::int AS oid, array_agg(enumlabel::text ORDER BY enumsortorder) AS labels FROM pg_enum GROUP BY enumtypid`,
  )
  const views = await client.query<ViewRow>(`
    SELECT c.oid::int AS view, pg_get_viewdef(c.oid) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm') AND ${SYSTEM}`)
  const functions = await client.query<{ proname: string }>(`
    SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${SYSTEM}`)
  const operators = await client.query<{ oprname: string }>(`
    SELECT DISTINCT o.oprname FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE ${SYSTEM}`)
  const setReturning = await client.query<{ proname: string }>(`SELECT DISTINCT proname FROM pg_proc WHERE proretset`)
  const system = await client.query<{ relname: string }>(`
    SELECT DISTINCT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('pg_catalog', 'information_schema')`)
  const types = await client.query<{ typname: string }>(`
    SELECT DISTINCT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE ${SYSTEM}`)
  const role = await client.query<{ admin: boolean }>(
    `SELECT rolsuper OR rolreplication AS admin FROM pg_roles WHERE rolname = current_user`,
  )
  const writable = await client.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND ${SYSTEM}
      AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')`)

  return buildCatalog({
    relations: relations.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    enums: new Map(enums.rows.map((e) => [e.oid, e.labels])),
    views: views.rows,
    functions: functions.rows.map((f) => f.proname),
    operators: operators.rows.map((o) => o.oprname),
    types: types.rows.map((t) => t.typname),
    setReturning: setReturning.rows.map((f) => f.proname),
    system: system.rows.map((r) => r.relname),
    writable: writable.rows[0]?.count ?? 0,
    admin: role.rows[0]?.admin ?? false,
  })
}

export interface CatalogRows {
  relations: RelationRow[]
  columns: ColumnRow[]
  constraints: ConstraintRow[]
  enums: Map<number, string[]>
  views: ViewRow[]
  functions: string[]
  operators: string[]
  types: string[]
  setReturning: string[]
  system: string[]
  writable: number
  admin: boolean
}

/** The neutral schema from catalog rows: field ids are table.column, or schema.table.column outside public. */
export function buildCatalog(rows: CatalogRows): Catalog {
  const byOid = new Map(rows.relations.map((r) => [r.oid, r]))
  const entityId = (r: RelationRow) => (r.nspname === 'public' ? r.relname : `${r.nspname}.${r.relname}`)
  const columnsOf = new Map<number, ColumnRow[]>()
  for (const c of rows.columns) columnsOf.set(c.attrelid, [...(columnsOf.get(c.attrelid) ?? []), c])

  const catalog: Catalog = {
    schema: { entities: [] },
    columns: new Map(),
    relations: new Map(),
    enums: rows.enums,
    functions: new Set(rows.functions),
    operators: new Set(rows.operators),
    types: new Set(rows.types),
    setReturning: new Set(rows.setReturning),
    system: new Set(rows.system),
    tables: 0,
    views: 0,
    writable: rows.writable,
    admin: rows.admin,
  }

  const fieldsByOid = new Map<number, Map<number, Field>>()
  for (const relation of rows.relations) {
    if (relation.parent !== null) continue // A partition shares its parent's fields.
    const id = entityId(relation)
    const fields = (columnsOf.get(relation.oid) ?? []).map(
      (c): Field => ({ id: `${id}.${c.attname}`, name: c.attname, type: neutralType(c, rows.enums) }),
    )
    const entity: Entity = { id, name: relation.relname, fields }
    catalog.schema.entities.push(entity)
    if (relation.relkind === 'v' || relation.relkind === 'm') catalog.views++
    else catalog.tables++
    fieldsByOid.set(relation.oid, new Map((columnsOf.get(relation.oid) ?? []).map((c, i) => [c.attnum, fields[i]!])))
  }

  // Partitions: their columns are the parent's, by name.
  for (const relation of rows.relations) {
    if (relation.parent === null) continue
    const parent = byOid.get(relation.parent)
    const parentFields = fieldsByOid.get(relation.parent)
    if (!parent || !parentFields) continue
    const byName = new Map([...parentFields.values()].map((f) => [f.name, f]))
    fieldsByOid.set(
      relation.oid,
      new Map((columnsOf.get(relation.oid) ?? []).flatMap((c) => (byName.has(c.attname) ? [[c.attnum, byName.get(c.attname)!]] : []))),
    )
  }

  const fieldAt = (oid: number, attnum: number) => fieldsByOid.get(oid)?.get(attnum)

  for (const constraint of rows.constraints) {
    const own = constraint.conkey.map((n) => fieldAt(constraint.conrelid, n))
    if (constraint.contype === 'f' && constraint.confkey) {
      constraint.confkey.forEach((n, i) => {
        const target = fieldAt(constraint.confrelid, n)
        const field = own[i]
        if (field && target && field !== target) field.references = target.id
      })
    } else if (own.length === 1 && own[0]) {
      own[0].key = constraint.contype === 'p' ? 'primary' : (own[0].key ?? 'unique')
    }
  }

  // A view column shares the values of the column it selects unchanged; a column it computes fakes on its own.
  const relationOf = (schema: string | undefined, name: string) => {
    const matches = rows.relations.filter((r) => r.relname === name && (schema ? r.nspname === schema : true))
    return (schema ? matches : matches.filter((r) => r.nspname === 'public'))[0] ?? (matches.length === 1 ? matches[0] : undefined)
  }
  const columnOf = (relation: RelationRow, column: string) => {
    const row = (columnsOf.get(relation.oid) ?? []).find((c) => c.attname === column)
    return row ? fieldAt(relation.oid, row.attnum) : undefined
  }
  for (const { view, definition } of rows.views) {
    const fields = [...(fieldsByOid.get(view)?.values() ?? [])]
    viewSources(definition, relationOf, columnOf).forEach((source, i) => {
      const field = fields[i]
      if (field && source && source !== field && source.type.kind === field.type.kind) field.references = source.id
    })
  }

  for (const [oid, fields] of fieldsByOid) for (const [attnum, field] of fields) catalog.columns.set(`${oid}:${attnum}`, field)
  for (const relation of rows.relations) {
    const fields = fieldsByOid.get(relation.oid)
    const entity = catalog.schema.entities.find((e) => e.id === entityId(relation.parent === null ? relation : byOid.get(relation.parent)!))
    if (!fields || !entity) continue
    catalog.relations.set(`${relation.nspname}.${relation.relname}`, {
      entity,
      byName: new Map([...fields.values()].map((f) => [f.name, f])),
    })
  }
  return catalog
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the parse tree is Postgres's own, untyped here. */
type Node = Record<string, any>

/**
 * For each column of a view, the field it selects unchanged, from the view's
 * own definition: `SELECT u.email FROM users u` names users.email;
 * `upper(u.email)`, a cast, or a column of a subquery or a UNION names none.
 */
function viewSources(
  definition: string,
  relationOf: (schema: string | undefined, name: string) => RelationRow | undefined,
  columnOf: (relation: RelationRow, column: string) => Field | undefined,
): (Field | undefined)[] {
  let select: Node | undefined
  try {
    select = (parseSync(definition) as { stmts?: { stmt: Node }[] }).stmts?.[0]?.stmt.SelectStmt
  } catch {
    return []
  }
  if (!select || (select.op && select.op !== 'SETOP_NONE')) return []
  const from: { alias?: string; relation?: RelationRow; name: string }[] = []
  const collect = (item: Node) => {
    if (item.RangeVar) {
      const rv = item.RangeVar
      from.push({ name: rv.relname, alias: rv.alias?.aliasname, relation: relationOf(rv.schemaname, rv.relname) })
    } else if (item.JoinExpr) {
      collect(item.JoinExpr.larg)
      collect(item.JoinExpr.rarg)
    } else from.push({ name: '' }) // A subquery or a function: its columns name no field.
  }
  for (const item of select.fromClause ?? []) collect(item)
  return (select.targetList ?? []).map((target: Node) => {
    const names: (string | undefined)[] = (target.ResTarget?.val?.ColumnRef?.fields ?? []).map((f: Node) => f.String?.sval)
    if (!names.length || names.some((n) => n === undefined)) return undefined
    const column = names.at(-1)!
    const candidates = names.length === 1 ? from : from.filter((r) => (r.alias ?? r.name) === names.at(-2))
    // One known relation must hold it, and nothing unknown may.
    if (candidates.some((r) => !r.relation)) return undefined
    const holding = candidates.flatMap((r) => columnOf(r.relation!, column) ?? [])
    return holding.length === 1 ? holding[0] : undefined
  })
}

const STRING = new Set(['text', 'varchar', 'bpchar', 'char', 'name', 'citext'])
const INTEGER: Record<string, 2 | 4 | 8> = { int2: 2, int4: 4, int8: 8, oid: 4 }
const DECIMAL = new Set(['numeric', 'float4', 'float8', 'money'])
const SIMPLE: Record<string, FieldType> = {
  bool: { kind: 'boolean' },
  date: { kind: 'date' },
  timestamp: { kind: 'datetime' },
  timestamptz: { kind: 'datetime' },
  time: { kind: 'time' },
  timetz: { kind: 'time' },
  uuid: { kind: 'uuid' },
  json: { kind: 'json' },
  jsonb: { kind: 'json' },
  bytea: { kind: 'bytes' },
  inet: { kind: 'ip' },
  cidr: { kind: 'ip' },
}

/** A Postgres type, by name, in neutral terms. */
export function typeByName(name: string, typmod = -1): FieldType {
  if (STRING.has(name)) return typmod > 4 && name !== 'name' ? { kind: 'string', maxLength: typmod - 4 } : { kind: 'string' }
  if (name in INTEGER) return { kind: 'integer', bytes: INTEGER[name]! }
  if (DECIMAL.has(name)) return { kind: 'decimal' }
  return SIMPLE[name] ?? { kind: 'unknown' }
}

function neutralType(c: ColumnRow, enums: Map<number, string[]>): FieldType {
  if (c.typtype === 'e' && c.enumtypid !== null) return { kind: 'enum', labels: enums.get(c.enumtypid) ?? [] }
  if (c.typcategory === 'A' && c.element) {
    const of =
      c.element_type === 'e' && c.enumtypid !== null
        ? ({ kind: 'enum', labels: enums.get(c.enumtypid) ?? [] } as FieldType)
        : typeByName(c.element)
    return { kind: 'array', of }
  }
  if (c.typtype === 'd' && c.basetype) return typeByName(c.basetype, c.atttypmod)
  return typeByName(c.typname, c.atttypmod)
}

/** Built-in type OIDs, for values a query computes. Arrays map to their element type. */
const OIDS: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid',
  114: 'json', 3802: 'jsonb', 700: 'float4', 701: 'float8', 790: 'money', 1700: 'numeric', 1042: 'bpchar',
  1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1266: 'timetz',
  2950: 'uuid', 869: 'inet', 650: 'cidr',
}
const ARRAY_OIDS: Record<number, number> = {
  1000: 16, 1001: 17, 1002: 18, 1003: 19, 1016: 20, 1005: 21, 1007: 23, 1009: 25, 1028: 26, 199: 114, 3807: 3802,
  1021: 700, 1022: 701, 791: 790, 1231: 1700, 1014: 1042, 1015: 1043, 1182: 1082, 1183: 1083, 1115: 1114,
  1185: 1184, 1270: 1266, 2951: 2950, 1041: 869, 651: 650,
}

/** The neutral type of a result column no field holds. */
export function typeByOid(oid: number, enums: Map<number, string[]>): FieldType {
  const element = ARRAY_OIDS[oid]
  if (element !== undefined) return { kind: 'array', of: typeByOid(element, enums) }
  const labels = enums.get(oid)
  if (labels) return { kind: 'enum', labels }
  const name = OIDS[oid]
  return name ? typeByName(name) : { kind: 'unknown' }
}
