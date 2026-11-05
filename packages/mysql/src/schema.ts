import type { Entity, Field, FieldType, Schema } from '@sosie/core'

/** What the MySQL source knows about the upstream, beyond the neutral schema. */
export interface Catalog {
  schema: Schema
  /** The database the connection string names: a table named without a database is in it. */
  database: string
  /** A result column's database, table and column, to its field: `app.users.email`. */
  columns: Map<string, Field>
  /** A table or view by database and name, for resolving column references in a query. */
  relations: Map<string, { entity: Entity; byName: Map<string, Field> }>
  /** Stored functions outside the system databases: their code may read rows the guard cannot see. */
  functions: Set<string>
  tables: number
  views: number
  /** Views whose tables the login may not see (no SHOW VIEW): their columns are matched to tables by name only. */
  hiddenViews: number
  /** The login can change data, or reach files: the session is read-only, but a read-only login is safer. */
  writable: boolean
  admin: boolean
}

/** Databases MySQL keeps for itself: never entities, and what may be read of them is the guard's to say. */
export const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export interface TableRow {
  db: string
  name: string
  kind: string
}

export interface ColumnRow {
  db: string
  table: string
  name: string
  dataType: string
  columnType: string
  maxLength: number | null
}

export interface KeyRow {
  db: string
  table: string
  column: string
}

export interface ReferenceRow extends KeyRow {
  refDb: string
  refTable: string
  refColumn: string
}

/** A table a view reads, from information_schema.VIEW_TABLE_USAGE. */
export interface ViewUseRow {
  db: string
  view: string
  tableDb: string
  table: string
}

export interface CatalogRows {
  database: string
  tables: TableRow[]
  columns: ColumnRow[]
  viewUses?: ViewUseRow[]
  /** Columns that alone are a table's primary key, or a unique index. */
  primary: KeyRow[]
  unique: KeyRow[]
  references: ReferenceRow[]
  functions: string[]
  grants: string[]
}

/** A connection that answers SQL with rows of named values: mysql2's, at start-up. */
export type Querier = <T>(sql: string, values?: unknown[]) => Promise<T[]>

const NOT_SYSTEM = `NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')`

/** Read the catalog on a read-only connection: every database the login can see but MySQL's own. */
export async function readCatalog(query: Querier, database: string): Promise<Catalog> {
  const tables = await query<TableRow>(
    `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA ${NOT_SYSTEM}`,
  )
  const columns = await query<ColumnRow>(
    `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS \`table\`, COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            CHARACTER_MAXIMUM_LENGTH AS maxLength
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA ${NOT_SYSTEM} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
  )
  // An index of one column only: a key that a value alone names.
  const keys = await query<KeyRow & { primary: number }>(
    `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS \`table\`, MIN(COLUMN_NAME) AS \`column\`, INDEX_NAME = 'PRIMARY' AS \`primary\`
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA ${NOT_SYSTEM} AND NON_UNIQUE = 0
     GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME HAVING COUNT(*) = 1`,
  )
  const references = await query<ReferenceRow>(
    `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`, REFERENCED_TABLE_SCHEMA AS refDb,
            REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
     FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_SCHEMA ${NOT_SYSTEM}`,
  )
  const viewUses = await query<ViewUseRow>(
    `SELECT VIEW_SCHEMA AS db, VIEW_NAME AS view, TABLE_SCHEMA AS tableDb, TABLE_NAME AS \`table\`
     FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA ${NOT_SYSTEM}`,
  )
  const functions = await query<{ name: string }>(
    `SELECT DISTINCT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_TYPE = 'FUNCTION' AND ROUTINE_SCHEMA ${NOT_SYSTEM}`,
  )
  const grants = (await query<Record<string, string>>('SHOW GRANTS')).map((row) => Object.values(row)[0] ?? '')
  return buildCatalog({
    database,
    tables,
    columns,
    viewUses,
    primary: keys.filter((k) => Number(k.primary) === 1),
    unique: keys.filter((k) => Number(k.primary) !== 1),
    references,
    functions: functions.map((f) => f.name),
    grants,
  })
}

/** The neutral schema from catalog rows: field ids are table.column, or db.table.column outside the named database. */
export function buildCatalog(rows: CatalogRows): Catalog {
  const at = (db: string, table: string) => `${db}.${table}`.toLowerCase()
  const entityId = (db: string, table: string) => (db === rows.database ? table : `${db}.${table}`)
  const primary = new Set(rows.primary.map((k) => `${at(k.db, k.table)}.${k.column.toLowerCase()}`))
  const unique = new Set(rows.unique.map((k) => `${at(k.db, k.table)}.${k.column.toLowerCase()}`))
  const references = new Map(
    rows.references.map((r) => [`${at(r.db, r.table)}.${r.column.toLowerCase()}`, `${entityId(r.refDb, r.refTable)}.${r.refColumn}`]),
  )
  const catalog: Catalog = {
    schema: { entities: [] },
    database: rows.database,
    columns: new Map(),
    relations: new Map(),
    functions: new Set(rows.functions.map((f) => f.toLowerCase())),
    tables: rows.tables.filter((t) => t.kind !== 'VIEW').length,
    views: rows.tables.filter((t) => t.kind === 'VIEW').length,
    hiddenViews: rows.viewUses ? rows.tables.filter((t) => t.kind === 'VIEW' && !rows.viewUses!.some((u) => u.db === t.db && u.view === t.name)).length : 0,
    writable: rows.grants.some((g) => /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(g.split(' ON ')[0] ?? '')),
    admin: rows.grants.some((g) => /\b(ALL PRIVILEGES|SUPER|FILE|SYSTEM_VARIABLES_ADMIN|PROCESS)\b/i.test(g.split(' ON ')[0] ?? '') && / ON \*\.\* /i.test(g)),
  }
  const columnsOf = new Map<string, ColumnRow[]>()
  for (const c of rows.columns) columnsOf.set(at(c.db, c.table), [...(columnsOf.get(at(c.db, c.table)) ?? []), c])
  // A view's column named as a column of exactly one table the view reads shares that column's values: a view's email
  // is its table's. One it renames, or that more than one of its tables has, is its own.
  const usedBy = new Map<string, ViewUseRow[]>()
  for (const u of rows.viewUses ?? []) usedBy.set(at(u.db, u.view), [...(usedBy.get(at(u.db, u.view)) ?? []), u])
  // Without SHOW VIEW, MySQL hides which tables a view reads: then a column only one table of its database has.
  const baseTables = rows.tables.filter((t) => t.kind !== 'VIEW')
  const viewReference = (db: string, view: string, column: string) => {
    const used = usedBy.get(at(db, view)) ?? baseTables.filter((t) => t.db === db).map((t) => ({ tableDb: t.db, table: t.name }))
    const holding = used.flatMap((u) =>
      (columnsOf.get(at(u.tableDb, u.table)) ?? []).filter((c) => c.name.toLowerCase() === column.toLowerCase()),
    )
    return holding.length === 1 ? `${entityId(holding[0]!.db, holding[0]!.table)}.${holding[0]!.name}` : undefined
  }
  for (const table of rows.tables) {
    const id = entityId(table.db, table.name)
    const fields = (columnsOf.get(at(table.db, table.name)) ?? []).map((c): Field => {
      const key = `${at(c.db, c.table)}.${c.name.toLowerCase()}`
      const reference = references.get(key) ?? (table.kind === 'VIEW' ? viewReference(table.db, table.name, c.name) : undefined)
      return {
        id: `${id}.${c.name}`,
        name: c.name,
        type: typeOf(c.dataType, c.columnType, c.maxLength === null ? null : Number(c.maxLength)),
        ...(primary.has(key) ? { key: 'primary' as const } : unique.has(key) ? { key: 'unique' as const } : {}),
        ...(reference && { references: reference }),
      }
    })
    const entity: Entity = { id, name: table.name, fields }
    catalog.schema.entities.push(entity)
    catalog.relations.set(at(table.db, table.name), { entity, byName: new Map(fields.map((f) => [f.name.toLowerCase(), f])) })
    for (const field of fields) catalog.columns.set(`${at(table.db, table.name)}.${field.name.toLowerCase()}`, field)
  }
  return catalog
}

/** A column's type in neutral terms, from information_schema's DATA_TYPE and COLUMN_TYPE. */
export function typeOf(dataType: string, columnType = '', maxLength: number | null = null): FieldType {
  const type = dataType.toLowerCase()
  // BOOL and BOOLEAN are tinyint(1).
  if (type === 'tinyint' && /^tinyint\(1\)/i.test(columnType)) return { kind: 'boolean' }
  // A tinyint's fake fits its one byte: a binary result has no room for more.
  if (type === 'tinyint') return { kind: 'integer', bytes: 1 }
  if (type === 'smallint' || type === 'year') return { kind: 'integer', bytes: 2 }
  if (type === 'mediumint' || type === 'int' || type === 'integer') return { kind: 'integer', bytes: 4 }
  if (type === 'bigint') return { kind: 'integer', bytes: 8 }
  if (['decimal', 'numeric', 'float', 'double', 'real'].includes(type)) return { kind: 'decimal' }
  if (type === 'char' || type === 'varchar') return maxLength ? { kind: 'string', maxLength } : { kind: 'string' }
  if (['tinytext', 'text', 'mediumtext', 'longtext', 'set'].includes(type)) return { kind: 'string' }
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(type)) return { kind: 'bytes' }
  if (type === 'date') return { kind: 'date' }
  if (type === 'datetime' || type === 'timestamp') return { kind: 'datetime' }
  if (type === 'time') return { kind: 'time' }
  if (type === 'json') return { kind: 'json' }
  if (type === 'bit') return { kind: 'bits', length: Number(/^bit\((\d+)\)/i.exec(columnType)?.[1] ?? 1) }
  if (type === 'enum') return { kind: 'enum', labels: enumLabels(columnType) }
  return { kind: 'unknown' }
}

/** The labels of an enum('a','it''s') column type. */
export function enumLabels(columnType: string): string[] {
  const body = /^enum\((.*)\)$/is.exec(columnType)?.[1] ?? ''
  return [...body.matchAll(/'((?:[^'\\]|''|\\.)*)'/g)].map((m) => m[1]!.replace(/''/g, "'").replace(/\\(.)/g, '$1'))
}

/* Result columns no field holds: their type is the protocol's. */

const CHARSET_BINARY = 63
const FLAG_ENUM = 256

/** The neutral type of a result column, from its protocol type code, character set and flags. */
export function typeOfColumn(code: number, charset: number, flags: number, length = 0): FieldType {
  if (flags & FLAG_ENUM) return { kind: 'string' }
  switch (code) {
    case 1: // TINY
      return length === 1 ? { kind: 'boolean' } : { kind: 'integer', bytes: 1 }
    case 2: // SHORT
    case 13: // YEAR
      return { kind: 'integer', bytes: 2 }
    case 3: // LONG
    case 9: // INT24
      return { kind: 'integer', bytes: 4 }
    case 8: // LONGLONG
      return { kind: 'integer', bytes: 8 }
    case 0: // DECIMAL
    case 4: // FLOAT
    case 5: // DOUBLE
    case 246: // NEWDECIMAL
      return { kind: 'decimal' }
    case 10: // DATE
    case 14: // NEWDATE
      return { kind: 'date' }
    case 7: // TIMESTAMP
    case 12: // DATETIME
    case 17:
    case 18:
      return { kind: 'datetime' }
    case 11: // TIME
    case 19:
      return { kind: 'time' }
    case 245: // JSON
      return { kind: 'json' }
    case 16: // BIT, its length in bits
      return { kind: 'bits', ...(length > 0 && { length }) }
    case 15: // VARCHAR
    case 249: // TINY_BLOB
    case 250: // MEDIUM_BLOB
    case 251: // LONG_BLOB
    case 252: // BLOB
    case 253: // VAR_STRING
    case 254: // STRING
      return charset === CHARSET_BINARY ? { kind: 'bytes' } : { kind: 'string' }
    default:
      // NULL, GEOMETRY, VECTOR and anything newer: nothing Sosie can fake by type.
      return { kind: 'unknown' }
  }
}
