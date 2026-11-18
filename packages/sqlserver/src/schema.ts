import type { Entity, Field, FieldType, Schema } from '@sosie/core'

/** What the SQL Server source knows about the upstream, beyond the neutral schema. */
export interface Catalog {
  schema: Schema
  /** The database the connection string names: the catalog is its. */
  database: string
  /** The login's default schema: a table named without one is in it, where more than one schema has that name. */
  defaultSchema: string
  /** A column by schema, table and column, lowercased: `dbo.users.email`. */
  columns: Map<string, Field>
  /** A table or view by schema and name, lowercased. */
  relations: Map<string, { entity: Entity; byName: Map<string, Field> }>
  /** The schemas that have a table or view of a name, by its name lowercased. */
  schemasOf: Map<string, string[]>
  /** User-defined functions, by name and by schema.name, lowercased: their code may read rows. */
  functions: Set<string>
  tables: number
  views: number
  /** Views whose tables the login may not see (no VIEW DEFINITION): their columns share a table's fakes only where one table has a column of that name. */
  hiddenViews: number
  /** The login can change data: Sosie refuses writes, but a read-only login is safer. */
  writable: boolean
  /** sysadmin, or db_owner. */
  admin: boolean
  /** Azure SQL Database: no USE, and no other database's tables. */
  azure: boolean
}

export interface TableRow {
  schema: string
  name: string
  /** U for a table, V for a view. */
  kind: string
}

export interface ColumnRow {
  schema: string
  table: string
  name: string
  type: string
  /** Bytes; -1 for a max type. */
  maxLength: number
}

export interface KeyRow {
  schema: string
  table: string
  column: string
}

export interface ReferenceRow extends KeyRow {
  refSchema: string
  refTable: string
  refColumn: string
}

export interface ViewUseRow {
  schema: string
  view: string
  tableSchema: string
  table: string
}

export interface LoginRow {
  defaultSchema: string
  database: string
  admin: boolean
  writable: boolean
  azure: boolean
}

export interface CatalogRows {
  tables: TableRow[]
  columns: ColumnRow[]
  primary: KeyRow[]
  unique: KeyRow[]
  references: ReferenceRow[]
  viewUses?: ViewUseRow[]
  functions: KeyRow[]
  login: LoginRow
}

type Rows = (sql: string) => Promise<Record<string, string | null>[]>

const MINE = 'o.is_ms_shipped = 0'

/** Read the catalog of the session's database, on Sosie's own session. */
export async function readCatalog(rows: Rows): Promise<Catalog> {
  const s = (v: string | null | undefined) => v ?? ''
  const tables = (
    await rows(`SELECT s.name AS [schema], o.name AS name, RTRIM(o.type) AS kind FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U', 'V') AND ${MINE}`)
  ).map((r) => ({ schema: s(r.schema), name: s(r.name), kind: s(r.kind) }))
  const columns = (
    await rows(`SELECT s.name AS [schema], o.name AS [table], c.name AS name, TYPE_NAME(c.system_type_id) AS type, c.max_length AS max_length
      FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U', 'V') AND ${MINE} ORDER BY s.name, o.name, c.column_id`)
  ).map((r) => ({ schema: s(r.schema), table: s(r.table), name: s(r.name), type: s(r.type), maxLength: Number(r.max_length ?? 0) }))
  // A unique index of one column (included columns aside): a key that a value alone names.
  const keys = await rows(`SELECT s.name AS [schema], o.name AS [table], MIN(c.name) AS [column], MAX(CAST(i.is_primary_key AS int)) AS [primary]
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      JOIN sys.objects o ON o.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE i.is_unique = 1 AND ${MINE} GROUP BY s.name, o.name, i.index_id HAVING COUNT(*) = 1`)
  const references = (
    await rows(`SELECT ps.name AS [schema], po.name AS [table], pc.name AS [column], rs.name AS ref_schema, ro.name AS ref_table, rc.name AS ref_column
      FROM sys.foreign_key_columns f
      JOIN sys.objects po ON po.object_id = f.parent_object_id JOIN sys.schemas ps ON ps.schema_id = po.schema_id
      JOIN sys.columns pc ON pc.object_id = f.parent_object_id AND pc.column_id = f.parent_column_id
      JOIN sys.objects ro ON ro.object_id = f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
      JOIN sys.columns rc ON rc.object_id = f.referenced_object_id AND rc.column_id = f.referenced_column_id
      WHERE f.constraint_object_id IN (SELECT constraint_object_id FROM sys.foreign_key_columns GROUP BY constraint_object_id HAVING COUNT(*) = 1)`)
  ).map((r) => ({ schema: s(r.schema), table: s(r.table), column: s(r.column), refSchema: s(r.ref_schema), refTable: s(r.ref_table), refColumn: s(r.ref_column) }))
  const viewUses = (
    await rows('SELECT VIEW_SCHEMA AS [schema], VIEW_NAME AS [view], TABLE_SCHEMA AS table_schema, TABLE_NAME AS [table] FROM INFORMATION_SCHEMA.VIEW_TABLE_USAGE')
  ).map((r) => ({ schema: s(r.schema), view: s(r.view), tableSchema: s(r.table_schema), table: s(r.table) }))
  const functions = (
    await rows(`SELECT s.name AS [schema], o.name AS [column], '' AS [table] FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('FN', 'IF', 'TF', 'FS', 'FT', 'AF') AND ${MINE}`)
  ).map((r) => ({ schema: s(r.schema), table: '', column: s(r.column) }))
  const [login] = await rows(`SELECT SCHEMA_NAME() AS default_schema, DB_NAME() AS db,
      CAST(IS_SRVROLEMEMBER('sysadmin') AS int) + CAST(ISNULL(IS_ROLEMEMBER('db_owner'), 0) AS int) AS admin,
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') + HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE')
        + HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') + HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') AS writable,
      CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition`)
  return buildCatalog({
    tables,
    columns,
    primary: keys.filter((k) => Number(k.primary) === 1).map((k) => ({ schema: s(k.schema), table: s(k.table), column: s(k.column) })),
    unique: keys.filter((k) => Number(k.primary) !== 1).map((k) => ({ schema: s(k.schema), table: s(k.table), column: s(k.column) })),
    references,
    viewUses,
    functions,
    login: {
      defaultSchema: s(login?.default_schema) || 'dbo',
      database: s(login?.db),
      admin: Number(login?.admin ?? 0) > 0,
      writable: Number(login?.writable ?? 0) > 0,
      azure: Number(login?.edition) === 5,
    },
  })
}

/** The neutral schema from catalog rows: an entity's id is its table's name in the default schema, schema.table in another. */
export function buildCatalog(rows: CatalogRows): Catalog {
  const at = (schema: string, table: string) => `${schema}.${table}`.toLowerCase()
  const defaultSchema = rows.login.defaultSchema
  const entityId = (schema: string, table: string) => (schema.toLowerCase() === defaultSchema.toLowerCase() ? table : `${schema}.${table}`)
  const keyOf = (k: KeyRow) => `${at(k.schema, k.table)}.${k.column.toLowerCase()}`
  const primary = new Set(rows.primary.map(keyOf))
  const unique = new Set(rows.unique.map(keyOf))
  const references = new Map(rows.references.map((r) => [keyOf(r), `${entityId(r.refSchema, r.refTable)}.${r.refColumn}`]))
  const catalog: Catalog = {
    schema: { entities: [] },
    database: rows.login.database,
    defaultSchema,
    columns: new Map(),
    relations: new Map(),
    schemasOf: new Map(),
    functions: new Set(rows.functions.flatMap((f) => [f.column.toLowerCase(), `${f.schema}.${f.column}`.toLowerCase()])),
    tables: rows.tables.filter((t) => t.kind !== 'V').length,
    views: rows.tables.filter((t) => t.kind === 'V').length,
    hiddenViews: rows.viewUses ? rows.tables.filter((t) => t.kind === 'V' && !rows.viewUses!.some((u) => u.schema === t.schema && u.view === t.name)).length : 0,
    writable: rows.login.writable,
    admin: rows.login.admin,
    azure: rows.login.azure,
  }
  const columnsOf = new Map<string, ColumnRow[]>()
  for (const c of rows.columns) columnsOf.set(at(c.schema, c.table), [...(columnsOf.get(at(c.schema, c.table)) ?? []), c])
  // A view's column named as a column of exactly one table the view reads shares that column's values: a view's email
  // is its table's. Browse mode names the table for a query's columns as it runs; this is the schema's, for describe.
  const usedBy = new Map<string, ViewUseRow[]>()
  for (const u of rows.viewUses ?? []) usedBy.set(at(u.schema, u.view), [...(usedBy.get(at(u.schema, u.view)) ?? []), u])
  const baseTables = rows.tables.filter((t) => t.kind !== 'V')
  const viewReference = (schema: string, view: string, column: string) => {
    const used = usedBy.get(at(schema, view)) ?? baseTables.map((t) => ({ tableSchema: t.schema, table: t.name }))
    const holding = used.flatMap((u) => (columnsOf.get(at(u.tableSchema, u.table)) ?? []).filter((c) => c.name.toLowerCase() === column.toLowerCase()))
    return holding.length === 1 ? `${entityId(holding[0]!.schema, holding[0]!.table)}.${holding[0]!.name}` : undefined
  }
  for (const table of rows.tables) {
    const id = entityId(table.schema, table.name)
    const fields = (columnsOf.get(at(table.schema, table.name)) ?? []).map((c): Field => {
      const key = `${at(c.schema, c.table)}.${c.name.toLowerCase()}`
      const reference = references.get(key) ?? (table.kind === 'V' ? viewReference(table.schema, table.name, c.name) : undefined)
      return {
        id: `${id}.${c.name}`,
        name: c.name,
        type: typeOf(c.type, c.maxLength),
        ...(primary.has(key) ? { key: 'primary' as const } : unique.has(key) ? { key: 'unique' as const } : {}),
        ...(reference && { references: reference }),
      }
    })
    const entity: Entity = { id, name: table.name, fields }
    catalog.schema.entities.push(entity)
    catalog.relations.set(at(table.schema, table.name), { entity, byName: new Map(fields.map((f) => [f.name.toLowerCase(), f])) })
    const name = table.name.toLowerCase()
    catalog.schemasOf.set(name, [...(catalog.schemasOf.get(name) ?? []), table.schema.toLowerCase()])
    for (const field of fields) catalog.columns.set(`${at(table.schema, table.name)}.${field.name.toLowerCase()}`, field)
  }
  return catalog
}

/** A column's type in neutral terms, from its system type's name and sys.columns' max_length (bytes, -1 for max). */
export function typeOf(type: string, maxLength = 0): FieldType {
  switch (type.toLowerCase()) {
    case 'bit':
      return { kind: 'boolean' }
    case 'tinyint':
      return { kind: 'integer', bytes: 1 }
    case 'smallint':
      return { kind: 'integer', bytes: 2 }
    case 'int':
      return { kind: 'integer', bytes: 4 }
    case 'bigint':
      return { kind: 'integer', bytes: 8 }
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
    case 'float':
    case 'real':
      return { kind: 'decimal' }
    case 'date':
      return { kind: 'date' }
    case 'time':
      return { kind: 'time' }
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
      return { kind: 'datetime' }
    case 'uniqueidentifier':
      return { kind: 'uuid' }
    case 'char':
    case 'varchar':
      return maxLength > 0 ? { kind: 'string', maxLength } : { kind: 'string' }
    case 'nchar':
    case 'nvarchar':
      return maxLength > 0 ? { kind: 'string', maxLength: maxLength / 2 } : { kind: 'string' }
    case 'text':
    case 'ntext':
      return { kind: 'string' }
    case 'binary':
    case 'varbinary':
    case 'image':
    case 'timestamp':
      return { kind: 'bytes' }
    default:
      // xml, sql_variant, geography, geometry, hierarchyid: nothing Sosie can fake by type.
      return { kind: 'unknown' }
  }
}

/**
 * The relation a result column's table names, as browse mode gives it: as the text that referred to it wrote it,
 * from table alone to server.database.schema.table. Undefined for a table of another database, a temp table, or a
 * bare name more than one schema has and the default schema does not.
 */
export function resolveTable(parts: readonly string[], catalog: Catalog, database: string): { entity: Entity; byName: Map<string, Field> } | undefined {
  const name = parts.at(-1)?.toLowerCase()
  if (!name || name.startsWith('#') || name.startsWith('@')) return undefined
  const db = (parts.length >= 3 ? parts.at(-3)! : database || catalog.database).toLowerCase()
  if (db && catalog.database && db !== catalog.database.toLowerCase()) return undefined
  let schema = parts.length >= 2 ? parts.at(-2)!.toLowerCase() : ''
  if (!schema) {
    const schemas = catalog.schemasOf.get(name) ?? []
    schema = schemas.length === 1 ? schemas[0]! : schemas.includes(catalog.defaultSchema.toLowerCase()) ? catalog.defaultSchema.toLowerCase() : ''
  }
  return schema ? catalog.relations.get(`${schema}.${name}`) : undefined
}
