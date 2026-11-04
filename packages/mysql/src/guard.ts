import * as sqlparser from '@guanmingchiu/sqlparser-ts'
import type { Field } from '@sosie/core'
import { SYSTEM_DATABASES, type Catalog } from './schema.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the parse tree is sqlparser's JSON, untyped here. */
type Node = Record<string, any>

let ready: Promise<void> | undefined
let dialect: InstanceType<typeof sqlparser.MySqlDialect> | undefined

/** Load the parser, sqlparser's MySQL dialect compiled to WebAssembly: once, before the first statement. */
export async function loadParser(): Promise<void> {
  await (ready ??= sqlparser.init())
  dialect ??= new sqlparser.MySqlDialect()
}

/** Parse a query into statements as MySQL reads them: executable comments included, adjacent strings joined. */
export function parseStatements(text: string): Node[] {
  if (!dialect) throw new Error('The MySQL parser is not loaded.')
  return sqlparser.parse(text, dialect) as Node[]
}

export interface Refusal {
  code: number
  sqlState: string
  message: string
}

/** Where a literal or parameter is compared: a field, a column of MySQL's own catalog, or something Sosie cannot tell. */
export type Near = Field | 'catalog' | undefined

export interface ConstRef {
  /** Where the literal is in the statement's text, as UTF-16 offsets. */
  start: number
  end: number
  /** Its value as MySQL reads it: escapes undone, adjacent strings joined. */
  value: string
  kind: 'string' | 'number'
  near: Near
}

/** An item of the select list: count(…), a *, a literal, or anything else. */
export type Target = 'count' | 'star' | 'constant' | 'other'

export interface Analysis {
  refusal?: Refusal
  /** Reads only MySQL's catalog, or no table at all: values computed pass, and nothing is turned back. */
  catalogOnly: boolean
  /** What answers: rows, the schema (SHOW, DESCRIBE: every value passes), an OK, or warnings, whose messages Sosie hides. */
  answer: 'rows' | 'schema' | 'ok' | 'warnings'
  targets?: Target[]
  consts: ConstRef[]
  /** Parameters (?) by position, from 1, and what each is compared with. */
  params: Map<number, Near>
}

export interface Limits {
  statementTimeout: number
  maxRows: number
}

const READ_ONLY = { code: 1792, sqlState: '25006' }
const DENIED = { code: 1227, sqlState: '42000' }
const UNSUPPORTED = { code: 1235, sqlState: '42000' }

const WRITE: Refusal = { ...READ_ONLY, message: 'This statement changes data. Sosie is read-only.' }

const WHERE = 'would reveal where your database is'
const QUERIES = 'holds queries with the real values in them'
const ROWS = 'holds real values from your tables'

/** MySQL's own databases: mysql holds password hashes and logs of queries; performance_schema and sys, queries with their values. */
const REFUSED_DATABASES: Record<string, string> = {
  mysql: 'holds password hashes and logs of queries',
  performance_schema: QUERIES,
  sys: QUERIES,
}

/** Tables of information_schema that hold values, queries, or where the database is; the rest is the schema, and passes. */
const REFUSED_CATALOG: Record<string, string> = {
  processlist: QUERIES,
  innodb_trx: QUERIES,
  optimizer_trace: QUERIES,
  column_statistics: ROWS,
  innodb_lock_waits: ROWS,
  innodb_locks: ROWS,
  files: WHERE,
  innodb_datafiles: WHERE,
  innodb_tablespaces: WHERE,
  innodb_tablespaces_brief: WHERE,
}

/** Settings that say where the database, its files or its peers are. */
const LOCATION = new Set([
  'hostname', 'datadir', 'basedir', 'port', 'socket', 'tmpdir', 'pid_file', 'log_error', 'general_log_file', 'slow_query_log_file',
  'secure_file_priv', 'plugin_dir', 'character_sets_dir', 'lc_messages_dir', 'innodb_data_home_dir', 'innodb_log_group_home_dir',
  'innodb_undo_directory', 'innodb_temp_tablespaces_dir', 'innodb_tmpdir', 'innodb_directories', 'innodb_data_file_path',
  'innodb_temp_data_file_path', 'report_host', 'report_port', 'report_user', 'report_password', 'bind_address', 'admin_address',
  'admin_port', 'mysqlx_bind_address', 'mysqlx_port', 'mysqlx_socket', 'relay_log', 'relay_log_basename', 'relay_log_index',
  'relay_log_info_file', 'log_bin', 'log_bin_basename', 'log_bin_index', 'ssl_ca', 'ssl_capath', 'ssl_cert', 'ssl_key', 'ssl_crl',
  'ssl_crlpath', 'admin_ssl_ca', 'admin_ssl_cert', 'admin_ssl_key', 'replica_load_tmpdir', 'slave_load_tmpdir', 'init_file',
  'keyring_file_data', 'auto_generated_certs', 'debug',
])

/** Functions that read files, take locks other sessions wait on, or wait on replication. */
const REFUSED_FUNCTIONS: Record<string, string> = {
  load_file: 'reads files on the database server',
  get_lock: 'holds a lock other sessions wait on',
  release_lock: 'holds a lock other sessions wait on',
  release_all_locks: 'holds a lock other sessions wait on',
  is_used_lock: 'tells which session holds a lock',
  source_pos_wait: 'waits on replication',
  master_pos_wait: 'waits on replication',
  wait_for_executed_gtid_set: 'waits on replication',
  sys_exec: 'runs a program on the database server',
  sys_eval: 'runs a program on the database server',
}

/** Settings that keep the session read-only, its text read as Sosie reads it, and its limits. */
const READ_ONLY_SETTINGS = new Set(['transaction_read_only', 'tx_read_only'])
const LEXICAL_MODES = /\b(ANSI_QUOTES|NO_BACKSLASH_ESCAPES|PIPES_AS_CONCAT|ANSI)\b/i
const CHARSETS = new Set(['character_set_client', 'character_set_connection', 'character_set_results', 'collation_connection', 'names'])

/** SHOW … statements sqlparser reads as words: these show the schema, the login or counters, nothing from rows. */
const SHOW_WORDS_ALLOWED = [/^(INDEX|INDEXES|KEYS) (FROM|IN) /, /^GRANTS( FOR .*)?$/, /^TABLE STATUS/, /^TRIGGERS/, /^(PROCEDURE|FUNCTION) STATUS/, /^EVENTS/, /^PRIVILEGES$/, /^CHARACTER SET/, /^CHARSET/, /^ENGINES$/, /^OPEN TABLES/]

interface Relation {
  alias: string
  db?: string
  name?: string
  /** MySQL's own catalog: its columns are not fields, and what is compared with them is not a fake. */
  system?: boolean
  byName?: Map<string, Field>
}

interface Scope {
  relations: Relation[]
  ctes: Set<string>
  parent?: Scope
}

/** What a statement does, whether Sosie runs it, and which literals in it may be fakes to turn back. */
export function analyze(stmt: Node, text: string, catalog: Catalog, database: string, limits: Limits): Analysis {
  return new Analyzer(catalog, database, limits, text).statement(stmt)
}

class Analyzer {
  #refusal: Refusal | undefined
  #data = false
  readonly #consts: ConstRef[] = []
  readonly #params: { start: number; near: Near }[] = []
  readonly #placeholders: number[] = []
  readonly #offset: (line: number, column: number) => number

  constructor(
    private readonly catalog: Catalog,
    private readonly database: string,
    private readonly limits: Limits,
    private readonly text: string,
  ) {
    this.#offset = offsets(text)
  }

  statement(stmt: Node): Analysis {
    const [type, body] = Object.entries(stmt)[0] ?? ['', {}]
    let answer: Analysis['answer'] = 'ok'
    let targets: Target[] | undefined
    switch (type) {
      case 'Query':
        answer = 'rows'
        this.#query(body, undefined, (t) => (targets = t))
        break
      case 'ShowTables':
      case 'ShowColumns':
      case 'ShowDatabases':
      case 'ShowSchemas':
      case 'ShowCollation':
      case 'ShowStatus':
      case 'ShowFunctions':
      case 'ShowObjects':
      case 'ExplainTable':
        answer = 'schema'
        break
      case 'ShowCreate':
        answer = 'schema'
        if (!['Table', 'View', 'Trigger', 'Function', 'Procedure', 'Event'].includes(String(body.obj_type))) this.#refuse({ ...DENIED, message: 'Sosie does not show that.' })
        break
      case 'ShowVariable': {
        answer = 'schema'
        const words = (body.variable ?? []).map((w: Node) => String(w.value)).join(' ').toUpperCase()
        if (words === 'WARNINGS' || words === 'ERRORS') answer = 'warnings'
        else if (!SHOW_WORDS_ALLOWED.some((re) => re.test(words))) {
          this.#refuse({ ...DENIED, message: `Sosie does not run SHOW ${words}: it may show queries, values or where your database is.` })
        }
        break
      }
      case 'ShowVariables':
        this.#refuse({ ...DENIED, message: 'Sosie does not run SHOW VARIABLES: some say where your database is. Ask for one with SELECT @@name.' })
        break
      case 'ShowProcessList':
        this.#refuse({ ...DENIED, message: `Sosie does not run SHOW PROCESSLIST: it ${QUERIES}.` })
        break
      case 'Explain':
        this.#refuse({ ...UNSUPPORTED, message: 'Sosie does not run EXPLAIN: a plan would show the real values Sosie puts in your query.' })
        break
      case 'Set':
        this.#set(body)
        break
      case 'Use':
        break
      case 'StartTransaction':
        if ((body.modes ?? []).some((m: Node) => m.AccessMode === 'ReadWrite')) this.#refuse(WRITE)
        break
      case 'Commit':
      case 'Rollback':
      case 'Savepoint':
      case 'ReleaseSavepoint':
        break
      case 'Insert':
      case 'Update':
      case 'Delete':
      case 'Merge':
      case 'Truncate':
      case 'LoadData':
      case 'Copy':
        this.#refuse(WRITE)
        break
      default:
        this.#refuse(
          /^(Create|Drop|Alter|Rename|Grant|Revoke|Deny|Comment|Analyze|Optimize|Flush|Kill|LockTables|UnlockTables|Call|Install|Uninstall)/.test(type)
            ? WRITE
            : { ...UNSUPPORTED, message: `Sosie does not run this statement (${type || 'unknown'}): it reads with SELECT, SHOW and DESCRIBE.` },
        )
    }
    // Parameters are numbered by where they are in the text.
    const order = [...this.#placeholders].sort((a, b) => a - b)
    const params = new Map<number, Near>()
    for (const { start, near } of this.#params) params.set(order.indexOf(start) + 1, near)
    return {
      ...(this.#refusal && { refusal: this.#refusal }),
      catalogOnly: !this.#data,
      answer,
      ...(targets && { targets }),
      consts: this.#consts,
      params,
    }
  }

  #refuse(refusal: Refusal): void {
    this.#refusal ??= refusal
  }

  /* Queries and their scopes. */

  #query(q: Node, outer: Scope | undefined, onTargets?: (t: Target[]) => void): void {
    const scope: Scope = { relations: [], ctes: new Set(outer?.ctes ?? []), ...(outer && { parent: outer }) }
    for (const cte of q.with?.cte_tables ?? []) {
      this.#query(cte.query, scope)
      scope.ctes.add(String(cte.alias?.name?.value ?? '').toLowerCase())
    }
    if (q.locks?.length) {
      this.#refuse({ ...DENIED, message: 'Sosie does not lock rows (FOR UPDATE, FOR SHARE): other sessions would wait on them.' })
    }
    this.#setExpr(q.body, scope, onTargets)
    for (const key of ['order_by', 'limit_clause', 'limit', 'offset', 'fetch']) if (q[key]) this.#expr(q[key], scope)
  }

  #setExpr(body: Node, scope: Scope, onTargets?: (t: Target[]) => void): void {
    if (body.Select) return this.#select(body.Select, scope, onTargets)
    if (body.Query) return this.#query(body.Query, scope, onTargets)
    if (body.SetOperation) {
      this.#setExpr(body.SetOperation.left, scope, onTargets)
      this.#setExpr(body.SetOperation.right, scope)
      return
    }
    if (body.Values) return this.#expr(body.Values, scope)
    this.#refuse(WRITE)
  }

  #select(select: Node, outer: Scope, onTargets?: (t: Target[]) => void): void {
    const scope: Scope = { relations: [], ctes: outer.ctes, parent: outer }
    if (select.into) {
      this.#refuse({ ...DENIED, message: 'Sosie does not run SELECT … INTO: it puts values where Sosie cannot fake them.' })
    }
    for (const from of select.from ?? []) {
      this.#relation(from.relation, scope)
      for (const join of from.joins ?? []) this.#relation(join.relation, scope)
    }
    for (const from of select.from ?? []) for (const join of from.joins ?? []) this.#expr(join.join_operator, scope)
    onTargets?.((select.projection ?? []).map(target))
    for (const [key, value] of Object.entries(select)) {
      if (key === 'from' || key === 'into' || key === 'select_token') continue
      this.#expr(value, scope)
    }
  }

  #relation(relation: Node | undefined, scope: Scope): void {
    if (!relation) return
    if (relation.Table) {
      const table = relation.Table
      const parts = (table.name ?? []).map((p: Node) => String(p.Identifier?.value ?? p.value ?? ''))
      const alias = String(table.alias?.name?.value ?? parts.at(-1) ?? '')
      if (table.args) this.#expr(table.args, scope)
      if (parts.length === 1 && hasCte(scope, parts[0]!.toLowerCase())) {
        scope.relations.push({ alias })
        return
      }
      const db = (parts.length > 1 ? parts.at(-2)! : this.database).toLowerCase()
      const name = parts.at(-1)!.toLowerCase()
      if (db in REFUSED_DATABASES) return this.#refuse({ ...DENIED, message: `Sosie does not read ${db}: it ${REFUSED_DATABASES[db]}.` })
      if (db === 'information_schema') {
        const reason = REFUSED_CATALOG[name]
        if (reason) return this.#refuse({ ...DENIED, message: `Sosie does not read information_schema.${name}: it ${reason}.` })
        scope.relations.push({ alias, db, name, system: true })
        return
      }
      if (name === 'dual' && parts.length === 1) return
      // A table Sosie knows, or one it does not (made since it started, or out of its sight): either way, data.
      this.#data = true
      const known = this.catalog.relations.get(`${db}.${name}`)
      scope.relations.push({ alias, db, name, ...(known && { byName: known.byName }) })
      return
    }
    if (relation.Derived) {
      this.#query(relation.Derived.subquery, relation.Derived.lateral ? scope : (scope.parent ?? scope))
      scope.relations.push({ alias: String(relation.Derived.alias?.name?.value ?? '') })
      return
    }
    if (relation.NestedJoin) {
      const nested = relation.NestedJoin.table_with_joins
      this.#relation(nested?.relation, scope)
      for (const join of nested?.joins ?? []) {
        this.#relation(join.relation, scope)
        this.#expr(join.join_operator, scope)
      }
      return
    }
    // A table function (JSON_TABLE) or anything else: its arguments are read like expressions, and it may hold data.
    this.#data = true
    this.#expr(relation, scope)
    const alias = Object.values(relation)[0]?.alias?.name?.value
    scope.relations.push({ alias: String(alias ?? '') })
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
        // A SELECT or a FROM item reached by any other path is read as one, so no table it names goes unseen.
        case 'Select':
          this.#select(value, scope)
          continue
        case 'relation':
          this.#relation(value, scope)
          continue
        case 'joins':
          for (const join of value ?? []) {
            this.#relation(join.relation, scope)
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
          this.#identifier([String(value?.value ?? '')])
          continue
        case 'CompoundIdentifier':
          this.#identifier((value as Node[]).map((p) => String(p.value ?? '')))
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
        case 'Value':
          if (value?.value?.Placeholder !== undefined) this.#placeholder(value)
          continue
        default:
          this.#expr(value, scope)
      }
    }
  }

  #identifier(parts: string[]): void {
    const first = parts[0] ?? ''
    if (first.startsWith('@@')) {
      const name = (parts.length > 1 ? parts.at(-1)! : first.slice(2).replace(/^(session|global|local|persist)\./i, '')).toLowerCase()
      if (LOCATION.has(name)) this.#refuse({ ...DENIED, message: `Sosie does not show @@${name}: it ${WHERE}.` })
    } else if (first.startsWith('@')) {
      // A user variable may hold a value read from a row earlier: what it gives is faked like a value.
      this.#data = true
    }
  }

  #function(fn: Node, scope: Scope): void {
    const parts = (fn.name ?? []).map((p: Node) => String(p.Identifier?.value ?? p.value ?? '').toLowerCase())
    const name = parts.at(-1) ?? ''
    const reason = REFUSED_FUNCTIONS[name]
    if (reason) this.#refuse({ ...DENIED, message: `Sosie does not run ${name}(): it ${reason}.` })
    // A stored function's code may read rows the guard cannot see.
    if (parts.length > 1 || this.catalog.functions.has(name)) this.#data = true
    this.#expr(fn.args, scope)
    for (const key of ['over', 'filter', 'within_group']) if (fn[key]) this.#expr(fn[key], scope)
  }

  /* Comparisons: a literal or parameter on one side, the column it is compared with on the other. */

  #comparison(op: Node, scope: Scope): void {
    if (!['Eq', 'NotEq', 'Spaceship'].includes(String(op.op))) return
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

  /** A literal or a parameter compared with a column: kept to be turned back. */
  #compared(node: Node | undefined, near: Near): void {
    const literal = unwrapLiteral(node)?.Value
    if (!literal) return
    const value = literal.value ?? {}
    const span = literal.span
    if (value.Placeholder !== undefined) {
      if (span) this.#params.push({ start: this.#offset(span.start.line, span.start.column), near })
      return
    }
    const text = value.SingleQuotedString ?? value.DoubleQuotedString
    const number = Array.isArray(value.Number) ? value.Number[0] : undefined
    if ((text === undefined && number === undefined) || !span) return
    const start = this.#offset(span.start.line, span.start.column)
    const end = this.#offset(span.end.line, span.end.column)
    const kind = text !== undefined ? 'string' : 'number'
    const read = String(text ?? number)
    // Rewritten in place only where the text there reads as this one literal (not 'a' 'b' joined, nor an escape it cannot read).
    if (literalText(this.text.slice(start, end)) !== read) return
    this.#consts.push({ start, end, value: read, kind, near })
  }

  #placeholder(value: Node): void {
    const span = value.span
    if (span) this.#placeholders.push(this.#offset(span.start.line, span.start.column))
  }

  /** The field a column reference names; 'catalog' for MySQL's own; undefined for one Sosie cannot place; null for no column. */
  #resolve(node: Node | undefined, scope: Scope): Near | null {
    const ref = unwrapColumn(node)
    if (!ref) return null
    const parts = ref.map((p) => p.toLowerCase())
    const column = parts.at(-1)!
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const candidates =
        parts.length === 1
          ? s.relations.filter((r) => !r.byName || r.byName.has(column) || r.system)
          : s.relations.filter((r) => r.alias.toLowerCase() === parts.at(-2) && (parts.length < 3 || r.db === parts.at(-3)))
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
    if (body.SetNames) return this.#charset(String(body.SetNames.charset_name?.value ?? ''))
    if (body.SetTransaction) {
      if (body.SetTransaction.global || (body.SetTransaction.modes ?? []).some((m: Node) => m.AccessMode === 'ReadWrite')) this.#refuse(WRITE)
      return
    }
    const assignments: { scope?: string; name: string[]; value: Node }[] = []
    if (body.SingleAssignment) {
      const a = body.SingleAssignment
      assignments.push({ scope: a.scope, name: names(a.variable), value: a.values?.[0] })
      if ((a.values ?? []).length !== 1) this.#refuse({ ...UNSUPPORTED, message: 'Sosie sets one value per variable.' })
    } else if (body.MultipleAssignments) {
      for (const a of body.MultipleAssignments.assignments ?? []) assignments.push({ scope: a.scope, name: names(a.name), value: a.value })
    } else if (body.SetTimeZone) {
      return this.#expr(body.SetTimeZone.value, { relations: [], ctes: new Set() })
    } else {
      return this.#refuse({ ...UNSUPPORTED, message: 'Sosie does not run this SET.' })
    }
    for (const { scope, name, value } of assignments) this.#assign(scope, name, value)
  }

  #assign(scope: string | undefined, name: string[], value: Node | undefined): void {
    const first = name[0] ?? ''
    // A user variable: anything a query may read, which is then faked as a value wherever it comes back.
    if (first.startsWith('@') && !first.startsWith('@@')) return this.#expr(value, { relations: [], ctes: new Set() })
    if (scope && !/^session|local$/i.test(scope)) return this.#refuse({ ...DENIED, message: 'Sosie does not change the server’s settings: only this session’s.' })
    const prefix = first.startsWith('@@') ? first.slice(2).toLowerCase() : ''
    if (['global', 'persist', 'persist_only'].includes(prefix)) return this.#refuse({ ...DENIED, message: 'Sosie does not change the server’s settings: only this session’s.' })
    const setting = (name.length > 1 && ['@@session', '@@local', '@@global', '@@persist'].includes(first.toLowerCase()) ? name.at(-1)! : first.replace(/^@@/, '')).toLowerCase()
    // A setting's value is written in the query: copied from a row, it would come back real from SELECT @@name.
    const literal = settingValue(value)
    if (literal === undefined) return this.#refuse({ ...UNSUPPORTED, message: `Sosie sets ${setting} only to a value written in the query.` })
    if (READ_ONLY_SETTINGS.has(setting) && !/^(1|on|true)$/i.test(literal)) {
      return this.#refuse({ ...DENIED, message: `Sosie keeps ${setting} on: the session stays read-only.` })
    }
    if (setting === 'sql_mode' && (LEXICAL_MODES.test(literal) || /^default$/i.test(literal))) {
      return this.#refuse({ ...DENIED, message: 'Sosie keeps sql_mode without ANSI_QUOTES, NO_BACKSLASH_ESCAPES and PIPES_AS_CONCAT: it must read each statement as MySQL does.' })
    }
    if (CHARSETS.has(setting)) return this.#charset(literal)
    if (setting === 'max_execution_time') {
      const ms = Number(literal)
      if (!Number.isInteger(ms) || ms <= 0 || ms > this.limits.statementTimeout) {
        this.#refuse({ ...DENIED, message: `Sosie allows max_execution_time up to ${this.limits.statementTimeout} ms, the limit it was started with.` })
      }
    }
    if (setting === 'sql_select_limit') {
      const n = Number(literal)
      if (!Number.isInteger(n) || n < 0 || n > this.limits.maxRows + 1) this.#refuse({ ...DENIED, message: `Sosie allows sql_select_limit up to ${this.limits.maxRows + 1}.` })
    }
  }

  #charset(name: string): void {
    if (!/^(utf8mb4|utf8|utf8mb3)(_\w+)?$/i.test(name)) this.#refuse({ ...UNSUPPORTED, message: 'Sosie speaks utf8mb4: SET NAMES utf8mb4.' })
  }
}

function hasCte(scope: Scope | undefined, name: string): boolean {
  return !!scope?.ctes.has(name)
}

function names(variable: Node[] | undefined): string[] {
  return (variable ?? []).map((p: Node) => String(p.Identifier?.value ?? p.value ?? ''))
}

/** A setting's value as written: a literal, or a bare word (ON, DEFAULT); undefined for anything computed. */
function settingValue(node: Node | undefined): string | undefined {
  if (!node) return undefined
  const value = node.Value?.value
  if (value) {
    const v = value.SingleQuotedString ?? value.DoubleQuotedString ?? (Array.isArray(value.Number) ? value.Number[0] : value.Boolean)
    return v === undefined ? undefined : String(v)
  }
  if (node.Identifier && !String(node.Identifier.value).startsWith('@')) return String(node.Identifier.value)
  if (node.UnaryOp?.op === 'Minus') {
    const inner = settingValue(node.UnaryOp.expr)
    return inner === undefined ? undefined : `-${inner}`
  }
  return undefined
}

function target(item: Node): Target {
  if (item.Wildcard || item.QualifiedWildcard) return 'star'
  const expr = item.UnnamedExpr ?? item.ExprWithAlias?.expr
  if (!expr) return 'other'
  if (unwrapLiteral(expr) && !expr.Value?.value?.Placeholder) return 'constant'
  const fn = expr.Function
  if (fn && String(fn.name?.at(-1)?.Identifier?.value ?? '').toLowerCase() === 'count') return 'count'
  return 'other'
}

/** A column reference, through parentheses and a COLLATE: its name's parts. */
function unwrapColumn(node: Node | undefined): string[] | undefined {
  for (let n = node; n; ) {
    if (n.Identifier) return n.Identifier.value?.startsWith?.('@') ? undefined : [String(n.Identifier.value)]
    if (n.CompoundIdentifier) {
      const parts = (n.CompoundIdentifier as Node[]).map((p) => String(p.value))
      return parts[0]?.startsWith('@') ? undefined : parts
    }
    n = n.Nested ?? n.Collate?.expr
  }
  return undefined
}

/** A literal, through parentheses, a charset introducer (_utf8mb4'…') and a COLLATE. */
function unwrapLiteral(node: Node | undefined): Node | undefined {
  for (let n = node; n; ) {
    if (n.Value) return n
    n = n.Nested ?? n.Collate?.expr ?? n.Prefixed?.value
  }
  return undefined
}

/** The value one literal's text stands for, as MySQL reads it; undefined for anything but one literal. */
export function literalText(text: string): string | undefined {
  if (/^-?\d+(\.\d*)?([eE][+-]?\d+)?$/.test(text)) return text
  const quote = text[0]
  if ((quote !== "'" && quote !== '"') || text.at(-1) !== quote || text.length < 2) return undefined
  let out = ''
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i]!
    if (ch === quote) {
      if (text[i + 1] !== quote) return undefined
      out += quote
      i++
    } else if (ch === '\\') {
      const next = text[++i]
      if (next === undefined) return undefined
      out += ESCAPES[next] ?? next
    } else out += ch
  }
  return out
}

const ESCAPES: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', '%': '\\%', _: '\\_' }

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
