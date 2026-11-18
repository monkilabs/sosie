import { randomUUID } from 'node:crypto'
import * as sqlparser from '@guanmingchiu/sqlparser-ts'
import type { Field } from '@sosie/core'
import { LOCATION_PROPERTIES, NATIVE_FUNCTIONS, REFUSED_FUNCTIONS } from './functions.js'
import type { Catalog } from './schema.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the parse tree is sqlparser's JSON, untyped here. */
type Node = Record<string, any>

let ready: Promise<void> | undefined
let dialect: InstanceType<typeof sqlparser.MsSqlDialect> | undefined

/** Load the parser, sqlparser's T-SQL dialect compiled to WebAssembly: once, before the first statement. */
export async function loadParser(): Promise<void> {
  await (ready ??= sqlparser.init())
  dialect ??= new sqlparser.MsSqlDialect()
}

/**
 * The statements of `text`, every one of them. sqlparser ends a list of statements, without an error, at an END where
 * one could end (END TRY, END CATCH, END CONVERSATION): SQL Server reads on, and what follows would go to it unread. So
 * a statement of Sosie's own goes last, with a mark the client cannot know, and a parse that does not reach it throws.
 */
function parse(text: string): Node[] {
  if (!dialect) throw new Error('The T-SQL parser is not loaded.')
  const mark = `sosie:${randomUUID()}`
  const stmts = sqlparser.parse(`${text}\n;SELECT '${mark}'`, dialect) as Node[]
  const projection = stmts.at(-1)?.Query?.body?.Select?.projection
  const last = projection?.length === 1 && projection[0]?.UnnamedExpr?.Value?.value?.SingleQuotedString === mark
  const read = stmts.slice(0, -1)
  if (!last || JSON.stringify(read).includes(mark)) {
    throw new Error('sql parser error: Sosie reads no END TRY, END CATCH or END CONVERSATION, and would not see what follows it.')
  }
  return read
}

/** One statement of a batch, and where its text's lines and columns are in the batch. */
export interface Statement {
  stmt: Node
  /** A line and column of the statement's parse (from 1), as an offset in the batch's text. */
  at: (line: number, column: number) => number
}

/** Words a statement starts with: where T-SQL needs no semicolon between two, the parser stops at one. */
const STARTS = new Set([
  'SELECT', 'WITH', 'SET', 'USE', 'DECLARE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'IF', 'WHILE', 'EXEC', 'EXECUTE', 'PRINT', 'RAISERROR',
  'THROW', 'WAITFOR', 'RETURN', 'GOTO', 'BREAK', 'CONTINUE', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'DENY', 'BULK', 'DBCC', 'BACKUP', 'RESTORE', 'KILL', 'SHUTDOWN', 'RECONFIGURE',
  'CHECKPOINT', 'ENABLE', 'DISABLE', 'READTEXT', 'WRITETEXT', 'UPDATETEXT', 'REVERT', 'SETUSER',
])

const NO_END = /Expected: end of statement, found: (\S+) at Line: (\d+), Column: (\d+)/
const INSERT_EXEC = /found: (EXEC|EXECUTE) at Line: (\d+), Column: (\d+)/i
/** INSERT INTO @variable, just before an EXEC: a table variable filled by a procedure, as JDBC's getColumns sends one. */
const INSERT_INTO_VARIABLE = /\bINSERT\s+(?:INTO\s+)?(@[\w@#$]+)\s*$/i

/**
 * A batch's statements, as SQL Server reads them. T-SQL needs no semicolon between statements, and sqlparser reads
 * them only with one: where it stops at a word a statement starts with, the batch is read on from there. Anything
 * else it cannot read is a syntax error.
 */
export function parseBatch(text: string): Statement[] {
  const out: Statement[] = []
  let base = 0
  while (base < text.length) {
    const rest = text.slice(base)
    const push = (piece: string, stmts: Node[]) => {
      const offset = offsets(piece)
      const from = base
      for (const stmt of stmts) out.push({ stmt, at: (line, column) => from + offset(line, column) })
    }
    try {
      push(rest, parse(rest))
      return out
    } catch (error) {
      const text = String((error as Error).message ?? error)
      const exec = INSERT_EXEC.exec(text)
      if (exec) {
        // sqlparser reads no INSERT … EXEC: the INSERT is read here, and the EXEC as the statement it is.
        const cut = offsets(rest)(Number(exec[2]), Number(exec[3]))
        const insert = INSERT_INTO_VARIABLE.exec(rest.slice(0, cut))
        if (!insert) throw error
        const before = rest.slice(0, insert.index)
        if (before.trim()) push(before, parse(before))
        const from = base + insert.index
        out.push({ stmt: { InsertExec: { target: insert[1]! } }, at: () => from })
        base += cut
        continue
      }
      const m = NO_END.exec(text)
      if (!m || !STARTS.has(m[1]!.toUpperCase())) throw error
      const cut = offsets(rest)(Number(m[2]), Number(m[3]))
      if (cut <= 0) throw error
      push(rest.slice(0, cut), parse(rest.slice(0, cut)))
      base += cut
    }
  }
  return out
}

export interface Refusal {
  /** The error number the client sees: 3906 for a write, as a read-only database answers one. */
  number: number
  message: string
}

/** Where a literal or parameter is compared: a field, a column of SQL Server's own catalog, or something Sosie cannot tell. */
export type Near = Field | 'catalog' | undefined

export interface ConstRef {
  /** Where the literal is in the batch's text, N included, as UTF-16 offsets. */
  start: number
  end: number
  /** Its value as SQL Server reads it: '' read as '. */
  value: string
  kind: 'string' | 'number'
  /** Written N'…': a real value goes back the same way. */
  national: boolean
  near: Near
}

/** An item of the select list: count(…), a *, a literal, or anything else. */
export type Target = 'count' | 'star' | 'constant' | 'other'

/** What one result set of a batch is. */
export interface Shape {
  targets: Target[]
  /** FOR JSON: the result is JSON, in rows of 2033 characters at most. */
  json: boolean
}

export interface Analysis {
  refusal?: Refusal
  /** Reads only SQL Server's catalog, or no table at all: values computed pass, and nothing is turned back. */
  catalogOnly: boolean
  consts: ConstRef[]
  /** Parameters and variables (@name, lowercased) compared with a column, and what each is compared with. */
  params: Map<string, Near>
  /** The result sets the batch gives, in order; undefined where Sosie cannot tell how many (a procedure's). */
  shapes?: Shape[]
}

export interface Limits {
  maxRows: number
}

const WRITE: Refusal = { number: 3906, message: 'This statement changes data. Sosie is read-only.' }
const denied = (message: string): Refusal => ({ number: 229, message })
const unsupported = (message: string): Refusal => ({ number: 50000, message })

const WHERE = 'would say where your database is'
const QUERIES = 'holds queries with the real values in them'

/** Databases Sosie never reads: msdb holds jobs' commands, backups' paths and mail. */
const REFUSED_DATABASES: Record<string, string> = { msdb: "holds jobs' commands, backups' paths and mail" }

/**
 * Objects of SQL Server's catalog that hold values, queries, credentials, or where the database is; the rest is the
 * schema, and passes. The compatibility views (sysprocesses) resolve in any schema, so these do too.
 */
const REFUSED_CATALOG: Record<string, string> = {
  sql_logins: 'holds password hashes',
  syslogins: 'holds password hashes',
  sysxlogins: 'holds password hashes',
  credentials: 'names the credentials of the server',
  database_scoped_credentials: 'names the credentials of the database',
  servers: 'says where the linked servers are',
  sysservers: 'says where the linked servers are',
  master_files: WHERE,
  database_files: WHERE,
  sysfiles: WHERE,
  sysaltfiles: WHERE,
  sysdatabases: WHERE,
  sysdevices: WHERE,
  backup_devices: WHERE,
  traces: WHERE,
  server_file_audits: WHERE,
  database_mirroring: WHERE,
  availability_replicas: WHERE,
  availability_group_listeners: WHERE,
  availability_group_listener_ip_addresses: WHERE,
  tcp_endpoints: WHERE,
  server_event_session_fields: WHERE,
  external_data_sources: 'says where other databases are',
  linked_logins: 'names the logins of the linked servers',
  remote_logins: 'names the logins of the remote servers',
  transmission_queue: "holds Service Broker's messages, values among them",
  sysprocesses: QUERIES,
  syscacheobjects: QUERIES,
  query_store_query_text: QUERIES,
  query_store_plan: QUERIES,
  query_store_query: QUERIES,
  query_store_runtime_stats: QUERIES,
}

/**
 * SET options a session may set: none of them changes data, or shows a plan with the real values Sosie put in a query.
 * Not NOEXEC or PARSEONLY: a statement they skip gives no result set and no error, so the sets after it would not be
 * the ones the guard counted.
 */
const SESSION_OPTIONS = new Set([
  'NOCOUNT', 'ANSI_NULLS', 'ANSI_NULL_DFLT_ON', 'ANSI_NULL_DFLT_OFF', 'ANSI_PADDING', 'ANSI_WARNINGS', 'ANSI_DEFAULTS', 'ARITHABORT',
  'ARITHIGNORE', 'CONCAT_NULL_YIELDS_NULL', 'NUMERIC_ROUNDABORT', 'QUOTED_IDENTIFIER', 'CURSOR_CLOSE_ON_COMMIT', 'IMPLICIT_TRANSACTIONS',
  'XACT_ABORT', 'TEXTSIZE', 'LANGUAGE', 'DATEFORMAT', 'DATEFIRST', 'DEADLOCK_PRIORITY', 'LOCK_TIMEOUT', 'QUERY_GOVERNOR_COST_LIMIT',
  'FMTONLY', 'FORCEPLAN', 'CONCAT_NULL_YIELDS_NULL', 'ROWCOUNT',
])

/**
 * Catalog procedures: what they return is the schema, and passes. Not sp_helpdb or sp_helpfile, whose result sets
 * hold the paths of the database's files on the server.
 */
export const CATALOG_PROCEDURES = new Set([
  'sp_tables', 'sp_columns', 'sp_columns_100', 'sp_columns_managed', 'sp_pkeys', 'sp_fkeys', 'sp_statistics', 'sp_statistics_100',
  'sp_special_columns', 'sp_special_columns_100', 'sp_stored_procedures', 'sp_sproc_columns', 'sp_sproc_columns_100', 'sp_datatype_info',
  'sp_datatype_info_100', 'sp_server_info', 'sp_table_privileges', 'sp_column_privileges', 'sp_describe_first_result_set',
  'sp_describe_undeclared_parameters', 'sp_help', 'sp_helpindex', 'sp_helpconstraint', 'sp_helptext', 'sp_databases',
])

/** Table hints that lock rows other sessions wait on. */
const LOCKING_HINTS = new Set(['UPDLOCK', 'XLOCK', 'TABLOCKX', 'HOLDLOCK', 'SERIALIZABLE', 'REPEATABLEREAD', 'PAGLOCK', 'TABLOCK'])

interface Relation {
  alias: string
  /** SQL Server's own catalog: its columns are not fields, and what is compared with them is not a fake. */
  system?: boolean
  byName?: Map<string, Field>
  /** A derived table's or a CTE's column names, each of its byName or computed. */
  columns?: Set<string>
}

interface Columns {
  names: Set<string>
  byName: Map<string, Field>
}

interface Scope {
  relations: Relation[]
  ctes: Map<string, Columns | undefined>
  parent?: Scope
}

/** What a batch does, whether Sosie runs it, and which literals and parameters in it may be fakes to turn back. */
export function analyze(statements: Statement[], text: string, catalog: Catalog, database: string, limits: Limits): Analysis {
  return new Analyzer(catalog, database, limits, text).batch(statements)
}

class Analyzer {
  #refusal: Refusal | undefined
  #data = false
  readonly #consts: ConstRef[] = []
  readonly #params = new Map<string, Near>()
  #shapes: Shape[] | undefined = []
  /** Table variables a catalog procedure filled: what they hold is the schema. */
  readonly #catalogVariables = new Set<string>()
  /** The table variable the next EXEC fills: INSERT INTO @variable EXEC …. */
  #filling: string | undefined
  /** Where the statement being read is in the batch's text. */
  #at: Statement['at'] = () => 0

  constructor(
    private readonly catalog: Catalog,
    private database: string,
    private readonly limits: Limits,
    private readonly text: string,
  ) {}

  batch(statements: Statement[]): Analysis {
    for (const { stmt, at } of statements) {
      this.#at = at
      this.#statement(stmt)
    }
    return {
      ...(this.#refusal && { refusal: this.#refusal }),
      catalogOnly: !this.#data,
      consts: this.#consts,
      params: this.#params,
      ...(this.#shapes && { shapes: this.#shapes }),
    }
  }

  #refuse(refusal: Refusal): void {
    this.#refusal ??= refusal
  }

  #statement(stmt: Node): void {
    const [type, body] = Object.entries(stmt)[0] ?? ['', {}]
    const filling = this.#filling
    this.#filling = undefined
    if (filling && type !== 'Execute') return this.#refuse(unsupported('Sosie fills a table variable only from a catalog procedure: INSERT INTO @t EXEC sp_columns.'))
    switch (type) {
      case 'InsertExec':
        // A table variable is the session's, not the database's: filled from a catalog procedure, it holds the schema.
        this.#filling = String(body.target).toLowerCase()
        return
      case 'Query': {
        let shape: Shape | undefined
        this.#query(body, undefined, (s) => (shape = s))
        if (shape) this.#shapes?.push(shape)
        return
      }
      case 'Set':
        return this.#set(body)
      case 'Use': {
        const parts = names(body.Object ?? Object.values(body)[0])
        const db = (parts.at(-1) ?? '').toLowerCase()
        if (db in REFUSED_DATABASES) return this.#refuse(denied(`Sosie does not read ${db}: it ${REFUSED_DATABASES[db]}.`))
        if (db) this.database = db
        return
      }
      case 'StartTransaction':
        // BEGIN TRY and BEGIN CATCH, which sqlparser reads as BEGIN TRANSACTION.
        if (body.modifier === 'Try' || body.modifier === 'Catch') return this.#refuse(unsupported('Sosie does not run TRY…CATCH: send the statements themselves.'))
        if ((body.statements ?? []).length) for (const inner of body.statements) this.#statement(inner)
        if ((body.modes ?? []).some((m: Node) => m.AccessMode === 'ReadWrite')) this.#refuse(WRITE)
        return
      case 'Commit':
        if (body.modifier === 'Try' || body.modifier === 'Catch') return this.#refuse(unsupported('Sosie does not run TRY…CATCH: send the statements themselves.'))
        return
      case 'Rollback':
        return
      case 'Declare':
        for (const d of body.stmts ?? []) {
          if (d.declare_type && d.declare_type !== 'Variable' && JSON.stringify(d.declare_type).includes('Cursor')) {
            this.#refuse(unsupported('Sosie opens no cursors: read the rows with SELECT.'))
          }
          this.#expr(d.assignment ?? d.default ?? d.for_query, { relations: [], ctes: new Map() })
        }
        return
      case 'Execute':
        this.#execute(body, filling)
        return
      case 'Print':
        return this.#refuse(unsupported('Sosie does not run PRINT: what it prints is text Sosie cannot fake. SELECT the value instead.'))
      case 'Raiserror':
      case 'Throw':
        return this.#refuse(unsupported('Sosie does not raise errors of yours: their text could hold a value it cannot fake.'))
      case 'If':
        return this.#if(body)
      case 'While':
        return this.#refuse(unsupported('Sosie does not run WHILE: send the statements themselves.'))
      case 'Insert':
      case 'Update':
      case 'Delete':
      case 'Merge':
      case 'Truncate':
        return this.#refuse(WRITE)
      default:
        this.#refuse(
          /^(Create|Drop|Alter|Rename|Grant|Revoke|Deny|Comment|Analyze|Kill|Call|Install|Uninstall|Copy|Load)/.test(type)
            ? WRITE
            : unsupported(`Sosie does not run this statement (${type || 'unknown'}): it reads with SELECT, and runs SET, USE and transactions.`),
        )
    }
  }

  /**
   * IF … ELSE, as JDBC ends a transaction (IF @@TRANCOUNT > 0 ROLLBACK TRAN): its condition read as any expression,
   * and every branch's statements as statements. Which branch runs is the server's to say, so the result sets the
   * batch gives can no longer be counted.
   */
  #if(body: Node): void {
    const before = this.#shapes?.length
    const blocks = [body.if_block, ...(body.elseif_blocks ?? []), body.else_block].filter(Boolean)
    for (const block of blocks) {
      this.#expr(block.condition, { relations: [], ctes: new Map() })
      const statements = block.conditional_statements?.Sequence?.statements ?? block.conditional_statements?.BeginEnd?.statements ?? []
      for (const inner of statements) this.#statement(inner)
    }
    if (this.#shapes && this.#shapes.length !== before) this.#shapes = undefined
  }

  /* EXEC: only the catalog's procedures, whose results are the schema. */

  #execute(body: Node, filling?: string): void {
    const parts = names(body.name).map((p) => p.toLowerCase())
    const name = parts.at(-1) ?? ''
    if (body.immediate || !parts.length) return this.#refuse(unsupported('Sosie does not run a statement held in a string: send the statement itself.'))
    if (name === 'sp_executesql') return this.#refuse(unsupported('Sosie runs sp_executesql as drivers send it, as an RPC: send the statement and its parameters that way, or send the statement itself.'))
    // SQL Server's own procedures, in sys or dbo or no schema (master..sp_tables): one in a schema of yours is yours, and
    // one of four parts a linked server's.
    if (!CATALOG_PROCEDURES.has(name) || parts.length > 3 || (parts.length > 1 && !['sys', 'dbo', ''].includes(parts.at(-2)!))) {
      return this.#refuse(unsupported(`Sosie runs no procedures but the catalog's (sp_tables, sp_columns): ${name || 'this one'} may change data, or read rows Sosie cannot see.`))
    }
    // A catalog procedure returns the schema, whatever its arguments are: parameters (@P0) read no row.
    if (filling) this.#catalogVariables.add(filling)
    // Its result sets are the schema's, however many: Sosie cannot tell how many there are. Into a variable, none.
    else this.#shapes = undefined
  }

  /* Queries and their scopes. */

  #query(q: Node, outer: Scope | undefined, onShape?: (s: Shape | undefined) => void, onColumns?: (c: Columns | undefined) => void): void {
    const scope: Scope = { relations: [], ctes: new Map(outer?.ctes ?? []), ...(outer && { parent: outer }) }
    if (q.with?.recursive) for (const cte of q.with.cte_tables ?? []) scope.ctes.set(String(cte.alias?.name?.value ?? '').toLowerCase(), undefined)
    for (const cte of q.with?.cte_tables ?? []) {
      let columns: Columns | undefined
      this.#query(cte.query, scope, undefined, (c) => (columns = c))
      scope.ctes.set(String(cte.alias?.name?.value ?? '').toLowerCase(), cte.alias?.columns?.length ? undefined : columns)
    }
    if (q.for_clause?.Xml) this.#refuse(unsupported('Sosie fakes FOR JSON, but not FOR XML: SELECT the columns, or FOR JSON.'))
    let targets: Target[] | undefined
    let assigns = false
    this.#setExpr(q.body, scope, (t, a) => ((targets = t), (assigns = a)), onColumns)
    for (const key of ['order_by', 'limit_clause', 'limit', 'offset', 'fetch', 'settings']) if (q[key]) this.#expr(q[key], scope)
    // A SELECT that sets variables (SELECT @x = email) returns no rows.
    if (!assigns) onShape?.({ targets: targets ?? ['star'], json: !!q.for_clause?.Json })
  }

  #setExpr(body: Node, scope: Scope, onTargets?: (t: Target[], assigns: boolean) => void, onColumns?: (c: Columns | undefined) => void): void {
    if (body.Select) return this.#select(body.Select, scope, onTargets, onColumns)
    if (body.Query) return this.#query(body.Query, scope, (s) => onTargets?.(s?.targets ?? ['star'], !s), onColumns)
    if (body.SetOperation) {
      let left: Target[] | undefined
      let right: Target[] | undefined
      this.#setExpr(body.SetOperation.left, scope, (t) => (left = t))
      this.#setExpr(body.SetOperation.right, scope, (t) => (right = t))
      onTargets?.(branches(left, right), false)
      return
    }
    if (body.Values) return this.#expr(body.Values, scope)
    this.#refuse(WRITE)
  }

  #select(select: Node, outer: Scope, onTargets?: (t: Target[], assigns: boolean) => void, onColumns?: (c: Columns | undefined) => void): void {
    const scope: Scope = { relations: [], ctes: outer.ctes, parent: outer }
    if (select.into) this.#refuse(denied('Sosie does not run SELECT … INTO: it writes a table, and puts values where Sosie cannot fake them.'))
    for (const from of select.from ?? []) {
      this.#relation(from.relation, scope, false)
      for (const join of from.joins ?? []) this.#relation(join.relation, scope, /Apply/.test(String(join.join_operator ?? '')))
    }
    for (const from of select.from ?? []) for (const join of from.joins ?? []) this.#expr(join.join_operator, scope)
    const projection: Node[] = select.projection ?? []
    const assigns = projection.some((item) => String(item.ExprWithAlias?.alias?.value ?? '').startsWith('@'))
    if (assigns) this.#data = true
    onTargets?.(projection.map(target), assigns)
    onColumns?.(this.#columns(projection, scope))
    for (const [key, value] of Object.entries(select)) {
      if (key === 'from' || key === 'into' || key === 'select_token') continue
      this.#expr(value, scope)
    }
  }

  /** The columns a select list gives, for a derived table or a CTE: a column of a table keeps its field, so a literal compared with it outside turns back there. */
  #columns(items: Node[], scope: Scope): Columns | undefined {
    const given = new Set<string>()
    const byName = new Map<string, Field>()
    for (const item of items) {
      if (item.Wildcard || item.QualifiedWildcard) {
        const qualifier = item.QualifiedWildcard ? names(item.QualifiedWildcard[0]?.ObjectName ?? item.QualifiedWildcard[0]).at(-1)?.toLowerCase() : undefined
        for (const r of scope.relations.filter((r) => !qualifier || r.alias.toLowerCase() === qualifier)) {
          if (!r.byName) return undefined
          for (const name of r.columns ?? r.byName.keys()) given.add(name)
          for (const [name, field] of r.byName) byName.set(name, field)
        }
        continue
      }
      const expr = item.UnnamedExpr ?? item.ExprWithAlias?.expr
      const ref = unwrapColumn(expr)
      const name = (item.ExprWithAlias ? String(item.ExprWithAlias.alias?.value ?? '') : (ref?.at(-1) ?? '')).toLowerCase()
      if (!name || name.startsWith('@')) continue
      given.add(name)
      const near = ref ? this.#resolve(expr, scope) : undefined
      if (near && near !== 'catalog') byName.set(name, near)
    }
    return { names: given, byName }
  }

  #relation(relation: Node | undefined, scope: Scope, lateral: boolean): void {
    if (!relation) return
    if (relation.Table) {
      const table = relation.Table
      const parts = names(table.name)
      const alias = String(table.alias?.name?.value ?? parts.at(-1) ?? '')
      for (const hint of table.with_hints ?? []) {
        const word = String(unwrapColumn(hint)?.at(-1) ?? '').toUpperCase()
        if (LOCKING_HINTS.has(word)) this.#refuse(denied(`Sosie does not lock rows (${word}): other sessions would wait on them.`))
      }
      if (table.args) this.#expr(table.args, scope)
      if (parts.length > 3) return this.#refuse(denied('Sosie does not read other servers (linked servers): only its database.'))
      const name = (parts.at(-1) ?? '').toLowerCase()
      if (table.args) {
        // A table-valued function: SQL Server's own, or one of yours, which may read rows.
        const reason = REFUSED_FUNCTIONS[name]
        if (reason) return this.#refuse(denied(`Sosie does not run ${name}(): it ${reason}.`))
        if (name.startsWith('dm_')) this.#system(name, parts)
        this.#data = true
        scope.relations.push({ alias })
        return
      }
      if (parts.length === 1 && this.#catalogVariables.has(name)) {
        scope.relations.push({ alias, system: true })
        return
      }
      if (parts.length === 1 && scope.ctes.has(name)) {
        const columns = scopeCte(scope, name)
        scope.relations.push({ alias, ...(columns && { byName: columns.byName, columns: columns.names }) })
        return
      }
      const db = (parts.length === 3 ? parts[0]! : this.database).toLowerCase()
      const schema = (parts.length >= 2 ? parts.at(-2)! : '').toLowerCase()
      if (db in REFUSED_DATABASES) return this.#refuse(denied(`Sosie does not read ${db}: it ${REFUSED_DATABASES[db]}.`))
      if (schema === 'sys' || schema === 'information_schema' || name in REFUSED_CATALOG || name.startsWith('dm_')) {
        if (this.#system(name, parts)) scope.relations.push({ alias, system: true })
        return
      }
      // A table Sosie knows, or one it does not (made since it started, a temp table, one in master or tempdb): either
      // way, data. Only sys and INFORMATION_SCHEMA are the catalog: which database the session is in is the server's
      // to say, and a USE in a branch that never runs, or one that fails, leaves it where it was.
      this.#data = true
      const known = name.startsWith('#') || db !== this.catalog.database.toLowerCase() ? undefined : this.#known(schema, name)
      scope.relations.push({ alias, ...(known && { byName: known.byName }) })
      return
    }
    if (relation.Derived) {
      let columns: Columns | undefined
      this.#query(relation.Derived.subquery, relation.Derived.lateral || lateral ? scope : (scope.parent ?? scope), undefined, (c) => (columns = c))
      const renamed = relation.Derived.alias?.columns?.length
      const known = !renamed && columns ? { byName: columns.byName, columns: columns.names } : {}
      scope.relations.push({ alias: String(relation.Derived.alias?.name?.value ?? ''), ...known })
      return
    }
    if (relation.NestedJoin) {
      const nested = relation.NestedJoin.table_with_joins
      this.#relation(nested?.relation, scope, false)
      for (const join of nested?.joins ?? []) {
        this.#relation(join.relation, scope, /Apply/.test(String(join.join_operator ?? '')))
        this.#expr(join.join_operator, scope)
      }
      return
    }
    // OPENJSON, STRING_SPLIT, a table variable, anything else: what its arguments read, and data.
    this.#data = true
    this.#expr(relation, scope)
    const alias = Object.values(relation)[0]?.alias?.name?.value
    scope.relations.push({ alias: String(alias ?? '') })
  }

  /** A relation of the catalog: refused where it shows what Sosie must not; else read as the schema. */
  #system(name: string, parts: string[]): boolean {
    if (name.startsWith('dm_')) {
      this.#refuse(denied(`Sosie does not read ${parts.join('.')}: the dynamic management views hold queries, sessions, or where your database is.`))
      return false
    }
    const reason = REFUSED_CATALOG[name]
    if (reason) {
      this.#refuse(denied(`Sosie does not read ${parts.join('.')}: it ${reason}.`))
      return false
    }
    return true
  }

  #known(schema: string, name: string) {
    if (schema) return this.catalog.relations.get(`${schema}.${name}`)
    const schemas = this.catalog.schemasOf.get(name) ?? []
    const chosen = schemas.length === 1 ? schemas[0] : schemas.includes(this.catalog.defaultSchema.toLowerCase()) ? this.catalog.defaultSchema.toLowerCase() : undefined
    return chosen ? this.catalog.relations.get(`${chosen}.${name}`) : undefined
  }

  /* Expressions. */

  #expr(node: unknown, scope: Scope): void {
    if (Array.isArray(node)) {
      for (const item of node) this.#expr(item, scope)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Node)) {
      switch (key) {
        case 'span':
          continue
        case 'Subquery':
          this.#query(value, scope)
          continue
        case 'Select':
          this.#select(value, scope)
          continue
        case 'relation':
          this.#relation(value, scope, false)
          continue
        case 'joins':
          for (const join of value ?? []) {
            this.#relation(join.relation, scope, /Apply/.test(String(join.join_operator ?? '')))
            this.#expr(join.join_operator, scope)
          }
          continue
        case 'Exists':
          this.#query(value.subquery, scope)
          continue
        case 'InSubquery':
          this.#expr(value.expr, scope)
          this.#query(value.subquery, scope)
          continue
        case 'Function':
          this.#function(value, scope)
          continue
        case 'Identifier':
          this.#identifier(String(value?.value ?? ''))
          continue
        case 'CompoundIdentifier':
          this.#identifier(String((value as Node[])[0]?.value ?? ''))
          continue
        case 'BinaryOp':
          this.#comparison(value, scope)
          this.#expr(value.left, scope)
          this.#expr(value.right, scope)
          continue
        case 'InList':
          this.#inList(value, scope)
          this.#expr(value.expr, scope)
          this.#expr(value.list, scope)
          continue
        default:
          this.#expr(value, scope)
      }
    }
  }

  #identifier(name: string): void {
    if (name.startsWith('@@')) {
      const global = name.slice(2).toLowerCase()
      if (global === 'servername' || global === 'servicename') this.#refuse(denied(`Sosie does not show @@${global.toUpperCase()}: it ${WHERE}.`))
    } else if (name.startsWith('@')) {
      // A variable or a parameter may hold a value read from a row: what it gives is faked like a value.
      this.#data = true
    }
  }

  #function(fn: Node, scope: Scope): void {
    const parts = names(fn.name).map((p) => p.toLowerCase())
    const name = parts.at(-1) ?? ''
    const reason = REFUSED_FUNCTIONS[name]
    if (reason) this.#refuse(denied(`Sosie does not run ${name}(): it ${reason}.`))
    if (name === 'serverproperty' || name === 'connectionproperty') {
      const arg = literalArg(fn)
      if (arg === undefined || LOCATION_PROPERTIES.has(arg.toLowerCase())) {
        this.#refuse(denied(`Sosie does not show ${name.toUpperCase()}(${arg === undefined ? '…' : `'${arg}'`}): it ${WHERE}.`))
      }
    }
    if (name.startsWith('dm_')) this.#system(name, parts)
    // A user's function may read rows the guard cannot see, and one may have been made since Sosie started: any name but SQL Server's own reads data.
    if ((parts.length > 1 && parts.at(-2) !== 'sys') || this.catalog.functions.has(name) || !NATIVE_FUNCTIONS.has(name)) this.#data = true
    this.#expr(fn.args, scope)
    for (const key of ['over', 'filter', 'within_group']) if (fn[key]) this.#expr(fn[key], scope)
  }

  /* Comparisons: a literal or parameter on one side, the column it is compared with on the other. */

  #comparison(op: Node, scope: Scope): void {
    if (!['Eq', 'NotEq'].includes(String(op.op))) return
    for (const [column, other] of [
      [op.left, op.right],
      [op.right, op.left],
    ] as const) {
      const near = this.#resolve(column, scope)
      if (near === null) continue
      this.#compared(other, near)
    }
  }

  #inList(list: Node, scope: Scope): void {
    const near = this.#resolve(list.expr, scope)
    if (near === null) return
    for (const item of list.list ?? []) this.#compared(item, near)
  }

  /** A literal or a parameter compared with a column: kept, to be turned back. */
  #compared(node: Node | undefined, near: Near): void {
    const param = unwrapParameter(node)
    if (param) {
      const key = param.toLowerCase()
      // A parameter compared with two different columns is turned back with neither: it would be one or the other.
      this.#params.set(key, this.#params.has(key) && this.#params.get(key) !== near ? undefined : near)
      return
    }
    const literal = unwrapLiteral(node)?.Value
    if (!literal) return
    const value = literal.value ?? {}
    const span = literal.span
    const text = value.SingleQuotedString ?? value.NationalStringLiteral
    const number = Array.isArray(value.Number) ? value.Number[0] : undefined
    if ((text === undefined && number === undefined) || !span) return
    const start = this.#at(span.start.line, span.start.column)
    const end = this.#at(span.end.line, span.end.column)
    const read = String(text ?? number)
    if (literalText(this.text.slice(start, end)) !== read) return
    this.#consts.push({ start, end, value: read, kind: text !== undefined ? 'string' : 'number', national: value.NationalStringLiteral !== undefined, near })
  }

  /** The field a column reference names; 'catalog' for SQL Server's own; undefined for one Sosie cannot place; null for no column. */
  #resolve(node: Node | undefined, scope: Scope): Near | null {
    const ref = unwrapColumn(node)
    if (!ref) return null
    const parts = ref.map((p) => p.toLowerCase())
    const column = parts.at(-1)!
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const candidates =
        parts.length === 1
          ? s.relations.filter((r) => !r.byName || r.byName.has(column) || r.columns?.has(column) || r.system)
          : s.relations.filter((r) => r.alias.toLowerCase() === parts.at(-2))
      if (!candidates.length) continue
      if (candidates.length > 1) return undefined
      const relation = candidates[0]!
      if (relation.system) return 'catalog'
      return relation.byName?.get(column)
    }
    return undefined
  }

  /* SET. */

  #set(body: Node): void {
    if (body.SetTransaction) {
      if ((body.SetTransaction.modes ?? []).some((m: Node) => m.AccessMode === 'ReadWrite')) this.#refuse(WRITE)
      return
    }
    if (body.SingleAssignment) {
      const a = body.SingleAssignment
      const name = names(a.variable)[0] ?? ''
      if (!name.startsWith('@') || name.startsWith('@@')) return this.#refuse(unsupported(`Sosie does not set ${name || 'this'}.`))
      return this.#expr(a.values, { relations: [], ctes: new Map() })
    }
    const param = body.SetSessionParam
    if (param?.Statistics) {
      const topic = String(param.Statistics.topic ?? '').toUpperCase()
      if (topic !== 'IO' && topic !== 'TIME') this.#refuse(denied(`Sosie does not run SET STATISTICS ${topic}: a plan would show the real values Sosie puts in your query.`))
      return
    }
    const generic = param?.Generic
    if (!generic) return this.#refuse(unsupported('Sosie does not run this SET.'))
    const value = String(generic.value ?? '')
    for (const option of (generic.names ?? []).map((n: unknown) => String(n).toUpperCase())) {
      if (option === 'NO_BROWSETABLE') return this.#refuse(denied('Sosie keeps NO_BROWSETABLE on: it tells Sosie which column each value came from.'))
      if (/^SHOWPLAN/.test(option)) return this.#refuse(denied(`Sosie does not run SET ${option}: a plan would show the real values Sosie puts in your query.`))
      if (!SESSION_OPTIONS.has(option)) return this.#refuse(unsupported(`Sosie does not set ${option}.`))
      if (option === 'ROWCOUNT') {
        const n = Number(value)
        if (!Number.isInteger(n) || n <= 0 || n > this.limits.maxRows + 1) this.#refuse(denied(`Sosie allows ROWCOUNT from 1 to ${this.limits.maxRows + 1}.`))
      }
    }
  }
}

function scopeCte(scope: Scope, name: string): Columns | undefined {
  return scope.ctes.get(name)
}

/** An ObjectName's parts, or an identifier list's: brackets and quotes are the parser's. */
function names(parts: Node[] | Node | undefined): string[] {
  const list = Array.isArray(parts) ? parts : parts ? [parts] : []
  return list.map((p: Node) => String(p.Identifier?.value ?? p.value ?? ''))
}

function literalArg(fn: Node): string | undefined {
  const arg = fn.args?.List?.args?.[0]?.Unnamed?.Expr?.Value?.value
  return arg?.SingleQuotedString ?? arg?.NationalStringLiteral
}

function target(item: Node): Target {
  if (item.Wildcard || item.QualifiedWildcard) return 'star'
  const expr = item.UnnamedExpr ?? item.ExprWithAlias?.expr
  if (!expr) return 'other'
  if (unwrapLiteral(expr)) return 'constant'
  const fn = expr.Function
  const name = String(fn?.name?.at(-1)?.Identifier?.value ?? fn?.name?.at(-1)?.value ?? '').toLowerCase()
  if (name === 'count' || name === 'count_big') return 'count'
  return 'other'
}

/** A set operation's select list: a column is a count or a literal only where every branch has one in its place. */
function branches(left: Target[] | undefined, right: Target[] | undefined): Target[] {
  if (!left || !right || left.includes('star') || right.includes('star') || left.length !== right.length) return ['star']
  return left.map((t, i) => (t === right[i] ? t : 'other'))
}

/** A column reference, through parentheses and a COLLATE: its name's parts; never a variable. */
function unwrapColumn(node: Node | undefined): string[] | undefined {
  for (let n = node; n; ) {
    if (n.Identifier) return String(n.Identifier.value).startsWith('@') ? undefined : [String(n.Identifier.value)]
    if (n.CompoundIdentifier) {
      const parts = (n.CompoundIdentifier as Node[]).map((p) => String(p.value))
      return parts[0]?.startsWith('@') ? undefined : parts
    }
    n = n.Nested ?? n.Collate?.expr
  }
  return undefined
}

/** A parameter or variable, @name, through parentheses: its name. */
function unwrapParameter(node: Node | undefined): string | undefined {
  for (let n = node; n; ) {
    if (n.Identifier) {
      const name = String(n.Identifier.value)
      return name.startsWith('@') && !name.startsWith('@@') ? name : undefined
    }
    n = n.Nested ?? n.Collate?.expr
  }
  return undefined
}

/** A literal, through parentheses and a COLLATE. */
function unwrapLiteral(node: Node | undefined): Node | undefined {
  for (let n = node; n; ) {
    if (n.Value) return n
    n = n.Nested ?? n.Collate?.expr
  }
  return undefined
}

/** The value one literal's text stands for, as SQL Server reads it ('' is ', N'…' too); undefined for anything but one literal. */
export function literalText(text: string): string | undefined {
  if (/^\d+(\.\d*)?([eE][+-]?\d+)?$|^\.\d+([eE][+-]?\d+)?$/.test(text)) return text
  const body = /^[Nn]'/.test(text) ? text.slice(1) : text
  if (body.length < 2 || body[0] !== "'" || body.at(-1) !== "'") return undefined
  const inner = body.slice(1, -1)
  if (/'(?!')|(?<!')'$/.test(inner.replace(/''/g, ''))) return undefined
  return inner.replace(/''/g, "'")
}

/** Line and column, as sqlparser counts them (from 1, by character), to an offset in a JavaScript string. */
function offsets(text: string): (line: number, column: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (line, column) => {
    let at = starts[line - 1] ?? text.length
    for (let c = 1; c < column && at < text.length; c++) at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1
    return at
  }
}
