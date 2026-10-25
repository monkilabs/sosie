import type { Field } from '@sosie/core'
import { parseSync } from 'pgsql-parser'
import type { Catalog } from './schema.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the parse tree is Postgres's own, untyped here. */
type Node = Record<string, any>

export interface Parsed {
  stmt: Node
  /** The statement's own text, as the client sent it. */
  text: string
}

/** Split a query into statements with Postgres's own parser. Throws its syntax errors. */
export function parseStatements(text: string): Parsed[] {
  if (!text.trim()) return []
  const tree = parseSync(text) as { stmts?: { stmt: Node; stmt_location?: number; stmt_len?: number }[] }
  const bytes = Buffer.from(text, 'utf8')
  return (tree.stmts ?? []).map((s) => {
    const start = s.stmt_location ?? 0
    return { stmt: s.stmt, text: bytes.subarray(start, s.stmt_len ? start + s.stmt_len : undefined).toString('utf8') }
  })
}

export interface Refusal {
  code: string
  message: string
}

/** Where a constant or parameter is compared: a field, a catalog column, or something Sosie cannot tell. */
export type Near = Field | 'catalog' | undefined

export interface ConstRef {
  /** The A_Const node, to rewrite in place. */
  node: Node
  near: Near
  /** An array literal, '{1,2}', compared with = ANY. */
  array: boolean
}

export interface ParamRef {
  near: Near
  array: boolean
}

/** An item of the select list: count(…), a *, a column cast to another type (its field), or anything else. */
export type Target = 'count' | 'star' | 'other' | Field

export interface Analysis {
  refusal?: Refusal
  /** Reads only the catalogs, or no table at all: results pass unchanged, and nothing is rewritten. */
  catalogOnly: boolean
  /** The command tag of a result cut at the row cap. */
  command: string
  /** What each item of the select list is, to tell count(…) from values. */
  targets?: Target[]
  /** Constants compared with something; parameters by number. */
  consts: ConstRef[]
  params: Map<number, ParamRef>
}

export interface Limits {
  statementTimeout: number
}

const WRITE: Refusal = { code: '25006', message: 'This statement changes data. Sosie is read-only.' }

/** Catalogs that hold values from rows, or other sessions' queries with their values. */
const REFUSED_RELATIONS = new Set([
  'pg_stats',
  'pg_stats_ext',
  'pg_stats_ext_exprs',
  'pg_statistic',
  'pg_statistic_ext_data',
  'pg_stat_activity',
  'pg_stat_statements',
  'pg_stat_statements_info',
  'pg_prepared_statements',
  'pg_cursors',
  'pg_largeobject',
  'pg_authid',
  'pg_shadow',
  'pg_user_mapping',
  'pg_user_mappings',
  'pg_backend_memory_contexts',
])

const WHERE = 'would reveal where your database is'
const READS = 'reads data out of Sosie’s sight'
const REFUSED_FUNCTIONS: Record<string, string> = {
  inet_server_addr: WHERE,
  inet_server_port: WHERE,
  pg_read_file: READS,
  pg_read_binary_file: READS,
  pg_ls_dir: READS,
  pg_ls_logdir: READS,
  pg_ls_waldir: READS,
  pg_stat_file: READS,
  pg_current_logfile: READS,
  pg_stat_get_activity: 'returns other sessions’ queries with their values',
  pg_stat_statements: 'returns queries with their values',
  pg_stat_statements_info: 'returns queries with their values',
  lo_get: READS,
  lo_export: READS,
  lo_import: READS,
  lo_open: READS,
  loread: READS,
  pg_terminate_backend: 'acts on other sessions',
  pg_cancel_backend: 'acts on other sessions',
  pg_stat_get_backend_activity: 'returns other sessions’ queries with their values',
  pg_prepared_statement: 'returns statements with the real values Sosie put in them',
  pg_cursor: 'returns statements with the real values Sosie put in them',
  pg_get_backend_memory_contexts: 'returns statements with the real values Sosie put in them',
  ts_stat: READS,
  ts_rewrite: READS,
  get_raw_page: READS,
  heap_page_items: READS,
  heap_page_item_attrs: READS,
  tuple_data_split: READS,
  bt_page_items: READS,
}
/** Functions that run SQL given as text, or read raw data: the guard cannot see what they read. */
const READERS = /^((query|table|cursor|schema|database)_to_xml|dblink|pg_logical_slot_|pg_get_wal_)/

/** Functions that change the server or hold locks other sessions wait on: refused even when the login could run them. */
const ADMIN =
  /^(pg_(create|drop|copy)_\w+|pg_replication_\w+|pg_switch_wal|pg_reload_conf|pg_rotate_logfile|pg_stat_reset\w*|pg_stat_statements_reset|pg_notify|pg_(try_)?advisory_\w+|pg_backup_(start|stop)|pg_(start|stop)_backup|pg_promote|pg_wal_replay_\w+|pg_log_\w+|pg_logical_\w+|pg_sync_replication_slots|pg_file_\w+|pg_(restore|clear|set)_\w+_stats|pg_import_system_collations|lo_\w+|lowrite)$/

/** Settings a client may not change through Sosie: they keep the session read-only and its login what it is. */
const PROTECTED = new Set(['default_transaction_read_only', 'transaction_read_only', 'session_authorization', 'role'])

/**
 * Settings Sosie pins at start-up because they change how Postgres reads a
 * statement's text, which Sosie must read the same way: with
 * standard_conforming_strings off, 'a\'' ends somewhere else.
 */
const PINNED: Record<string, { value: string; allowed: RegExp }> = {
  standard_conforming_strings: { value: 'on', allowed: /^(on|true|yes|1)$/i },
  client_encoding: { value: 'UTF8', allowed: /^(utf-?8|unicode)$/i },
}

/** What a statement does, whether Sosie runs it, and what in it may be a fake to look up. */
export function analyze(stmt: Node, catalog: Catalog, limits: Limits): Analysis {
  return new Analyzer(catalog, limits).statement(stmt)
}

interface Relation {
  alias?: string
  schema?: string
  name: string
  fields?: Map<string, Field>
  catalog: boolean
}

interface Scope {
  relations: Relation[]
  ctes: Set<string>
  parent?: Scope
}

class Analyzer {
  #refusal: Refusal | undefined
  #data = false
  readonly #consts: ConstRef[] = []
  readonly #params = new Map<number, ParamRef>()

  constructor(
    readonly catalog: Catalog,
    readonly limits: Limits,
  ) {}

  statement(stmt: Node): Analysis {
    const [type, body] = Object.entries(stmt)[0] as [string, Node]
    let command = type.replace(/Stmt$/, '').toUpperCase()
    let targets: Target[] | undefined
    switch (type) {
      case 'SelectStmt':
        command = 'SELECT'
        this.#select(body, undefined, (t) => (targets = t))
        break
      case 'VariableShowStmt':
      case 'ClosePortalStmt':
      case 'DeallocateStmt':
      case 'DiscardStmt':
        break
      case 'VariableSetStmt':
        this.#set(body)
        break
      case 'TransactionStmt':
        this.#transaction(body)
        break
      case 'DeclareCursorStmt':
      case 'PrepareStmt':
        this.#walk(body.query, undefined)
        this.#data = true
        break
      case 'FetchStmt':
        command = 'FETCH'
        this.#data = true
        break
      case 'ExecuteStmt':
        command = 'SELECT'
        this.#walk(body.params, undefined)
        this.#data = true
        break
      case 'ExplainStmt':
        this.#refuse({
          code: '0A000',
          message: 'Sosie does not run EXPLAIN: a plan would show the real values Sosie puts in your query.',
        })
        break
      case 'CopyStmt':
        this.#refuse({ code: '0A000', message: 'Sosie does not run COPY. Use SELECT.' })
        break
      case 'ListenStmt':
      case 'UnlistenStmt':
      case 'NotifyStmt':
        this.#refuse({ code: '0A000', message: 'Sosie does not support LISTEN and NOTIFY.' })
        break
      default:
        this.#refuse(WRITE)
    }
    return {
      ...(this.#refusal && { refusal: this.#refusal }),
      catalogOnly: !this.#data,
      command,
      ...(targets && { targets }),
      consts: this.#consts,
      params: this.#params,
    }
  }

  #refuse(refusal: Refusal): void {
    this.#refusal ??= refusal
  }

  #set(body: Node): void {
    const name = String(body.name ?? '').toLowerCase()
    if (body.kind === 'VAR_RESET' || body.kind === 'VAR_RESET_ALL') return
    const pinned = PINNED[name]
    if (PROTECTED.has(name)) {
      this.#refuse({ code: '42501', message: `Sosie keeps ${name} as it is: the session stays read-only.` })
    } else if (pinned) {
      const value = constValue(body.args?.[0]?.A_Const)
      if (body.kind !== 'VAR_SET_DEFAULT' && !(body.kind === 'VAR_SET_VALUE' && pinned.allowed.test(String(value)))) {
        this.#refuse({ code: '42501', message: `Sosie keeps ${name} at ${pinned.value}: it must read each statement as Postgres does.` })
      }
    } else if (name === 'transaction' || name === 'session characteristics') {
      this.#transaction({ options: body.args })
    } else if (name === 'statement_timeout' && body.kind === 'VAR_SET_VALUE') {
      const ms = milliseconds(body.args?.[0]?.A_Const)
      if (ms === undefined || ms <= 0 || ms > this.limits.statementTimeout) {
        this.#refuse({
          code: '42501',
          message: `Sosie allows statement_timeout up to ${this.limits.statementTimeout} ms, the limit it was started with.`,
        })
      }
    }
  }

  #transaction(body: Node): void {
    if (['TRANS_STMT_PREPARE', 'TRANS_STMT_COMMIT_PREPARED', 'TRANS_STMT_ROLLBACK_PREPARED'].includes(body.kind)) {
      this.#refuse({ code: '0A000', message: 'Sosie does not support two-phase transactions.' })
    }
    for (const option of body.options ?? []) {
      const def = option.DefElem
      if (def?.defname === 'transaction_read_only' && !constValue(def.arg?.A_Const)) {
        this.#refuse({ code: '25006', message: 'Sosie is read-only: a transaction cannot be READ WRITE.' })
      }
    }
  }

  /** Visit every node; those that matter are handled on the way. */
  #walk(node: unknown, scope: Scope | undefined): void {
    if (Array.isArray(node)) {
      for (const item of node) this.#walk(item, scope)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== 'object') continue
      if (/^[A-Z]/.test(key)) this.#visit(key, value as Node, scope)
      else this.#walk(value, scope)
    }
  }

  #visit(type: string, body: Node, scope: Scope | undefined): void {
    switch (type) {
      case 'SelectStmt':
        return this.#select(body, scope)
      case 'InsertStmt':
      case 'UpdateStmt':
      case 'DeleteStmt':
      case 'MergeStmt':
        return this.#refuse(WRITE)
      case 'RangeVar':
        this.#relation(body, scope)
        return
      case 'FuncCall':
        this.#call(body)
        return this.#walk(body, scope)
      case 'A_Expr':
        this.#comparison(body, scope)
        return this.#walk(body, scope)
      default:
        return this.#walk(body, scope)
    }
  }

  /** A select, in its own scope. `top` receives the select list of the statement's own result. */
  #select(body: Node, outer: Scope | undefined, top?: (targets: Target[]) => void): void {
    const withScope = this.#with(body, outer)
    if (body.op && body.op !== 'SETOP_NONE') {
      // UNION, INTERSECT, EXCEPT: Postgres reports no source for these columns, and the arms differ,
      // so no select list speaks for them: `top` gets nothing, and every column is faked by type.
      this.#select(body.larg, withScope)
      this.#select(body.rarg, withScope)
      this.#walk([body.sortClause, body.limitCount, body.limitOffset], withScope)
      return
    }
    if (body.intoClause) this.#refuse({ code: '25006', message: 'SELECT INTO creates a table. Sosie is read-only.' })
    if (body.lockingClause) this.#refuse({ code: '25006', message: 'Sosie does not lock rows: it is read-only.' })

    const scope: Scope = { relations: [], ctes: new Set(), parent: withScope }
    for (const item of body.fromClause ?? []) this.#from(item, scope)
    top?.((body.targetList ?? []).map((t: Node) => this.#target(t.ResTarget?.val, scope)))
    this.#walk(
      [
        body.targetList,
        body.whereClause,
        body.groupClause,
        body.havingClause,
        body.windowClause,
        body.distinctClause,
        body.sortClause,
        body.limitCount,
        body.limitOffset,
        body.valuesLists,
      ],
      scope,
    )
  }

  /** The scope of a WITH clause: its CTEs are checked, and their names hide tables of the same name. */
  #with(body: Node, outer: Scope | undefined): Scope {
    const ctes = new Set<string>()
    const scope: Scope = { relations: [], ctes, ...(outer && { parent: outer }) }
    for (const cte of body.withClause?.ctes ?? []) {
      ctes.add(cte.CommonTableExpr.ctename)
      this.#walk(cte.CommonTableExpr.ctequery, scope)
    }
    return scope
  }

  #from(item: Node, scope: Scope): void {
    if (item.RangeVar) scope.relations.push(this.#relation(item.RangeVar, scope))
    else if (item.JoinExpr) {
      this.#from(item.JoinExpr.larg, scope)
      this.#from(item.JoinExpr.rarg, scope)
      this.#walk(item.JoinExpr.quals, scope)
    } else if (item.RangeSubselect) {
      this.#walk(item.RangeSubselect.subquery, scope)
      scope.relations.push({ name: item.RangeSubselect.alias?.aliasname ?? '', catalog: false })
    } else if (item.RangeFunction) {
      this.#walk(item.RangeFunction.functions, scope)
      scope.relations.push({ name: item.RangeFunction.alias?.aliasname ?? '', catalog: false })
    } else this.#walk(item, scope)
  }

  #relation(rv: Node, scope: Scope | undefined): Relation {
    const name: string = rv.relname
    const schema: string | undefined = rv.schemaname
    const alias: string | undefined = rv.alias?.aliasname
    if ((!schema || schema === 'pg_catalog') && REFUSED_RELATIONS.has(name)) {
      this.#refuse({ code: '42501', message: `${name} holds real values from your tables, so Sosie does not read it.` })
    }
    if (!schema) for (let s = scope; s; s = s.parent) if (s.ctes.has(name)) return { name, catalog: false, ...(alias && { alias }) }
    const known = this.catalog.relations.get(`${schema ?? 'public'}.${name}`) ?? (schema ? undefined : this.#unique(name))
    const catalog = !known && (schema === 'pg_catalog' || schema === 'information_schema' || (!schema && name.startsWith('pg_')))
    if (!catalog) this.#data = true
    return { name, catalog, ...(alias && { alias }), ...(schema && { schema }), ...(known && { fields: known.byName }) }
  }

  #unique(name: string) {
    const found = [...this.catalog.relations].filter(([key]) => key.endsWith(`.${name}`) && key.split('.').length === 2)
    return found.length === 1 ? found[0]![1] : undefined
  }

  #call(body: Node): void {
    const names: string[] = (body.funcname ?? []).map((n: Node) => n.String?.sval)
    const name = names.at(-1) ?? ''
    const schema = names.length > 1 ? names[0] : undefined
    const reason = REFUSED_FUNCTIONS[name] ?? (READERS.test(name) ? READS : undefined)
    if (reason) this.#refuse({ code: '42501', message: `Sosie does not run ${name}(): it ${reason}.` })
    if (ADMIN.test(name)) this.#refuse({ code: '25006', message: `Sosie does not run ${name}(): it changes the server. Sosie is read-only.` })
    if (name === 'set_config') {
      const setting = String(body.args?.[0]?.A_Const?.sval?.sval ?? '').toLowerCase()
      if (!setting || PROTECTED.has(setting) || setting in PINNED || setting === 'statement_timeout') {
        this.#refuse({ code: '42501', message: 'Sosie does not run set_config() on this setting: use SET.' })
      }
    }
    if (this.catalog.functions.has(name) && schema !== 'pg_catalog') this.#data = true
  }

  /** Equality comparisons: the constant or parameter on one side, the column it is compared with on the other. */
  #comparison(body: Node, scope: Scope | undefined): void {
    const op = body.name?.at(-1)?.String?.sval
    if (!['=', '<>', '!='].includes(op)) return
    switch (body.kind) {
      case 'AEXPR_OP':
      case 'AEXPR_DISTINCT':
      case 'AEXPR_NOT_DISTINCT': {
        const left = column(body.lexpr)
        const right = column(body.rexpr)
        if (left && literal(body.rexpr)) this.#record(body.rexpr, this.#resolve(left, scope), false)
        else if (right && literal(body.lexpr)) this.#record(body.lexpr, this.#resolve(right, scope), false)
        else if (literal(body.rexpr) && !literal(body.lexpr)) this.#record(body.rexpr, undefined, false)
        else if (literal(body.lexpr) && !literal(body.rexpr)) this.#record(body.lexpr, undefined, false)
        return
      }
      case 'AEXPR_IN': {
        const left = column(body.lexpr)
        const near = left ? this.#resolve(left, scope) : undefined
        for (const item of body.rexpr?.List?.items ?? []) if (literal(item)) this.#record(item, near, false)
        return
      }
      case 'AEXPR_OP_ANY':
      case 'AEXPR_OP_ALL': {
        const left = column(body.lexpr)
        const near = left ? this.#resolve(left, scope) : undefined
        const array = uncast(body.rexpr)
        if (array?.A_ArrayExpr) for (const item of array.A_ArrayExpr.elements ?? []) this.#record(item, near, false)
        else if (literal(body.rexpr)) this.#record(body.rexpr, near, true)
        return
      }
    }
  }

  #target(value: Node | undefined, scope: Scope): Target {
    if (value?.ColumnRef?.fields?.at(-1)?.A_Star) return 'star'
    // Only Postgres's own count(…): a function of the same name elsewhere could return anything.
    const name = value?.FuncCall?.funcname?.map((n: Node) => n.String?.sval)
    if (name?.at(-1) === 'count' && (name.length === 1 || name[0] === 'pg_catalog') && !this.catalog.functions.has('count')) {
      return 'count'
    }
    // users.role::text: Postgres reports a computed column; its values are still the field's.
    const fields = value?.TypeCast ? column(value) : undefined
    const near = fields ? this.#resolve(fields, scope) : undefined
    return near && near !== 'catalog' ? near : 'other'
  }

  #record(node: Node, near: Near, array: boolean): void {
    if (near === 'catalog') return
    const value = uncast(node)!
    if (value.ParamRef) this.#params.set(value.ParamRef.number, { near, array })
    else if (value.A_Const && !value.A_Const.isnull) this.#consts.push({ node: value.A_Const, near, array })
  }

  /** The field a column reference names, looking out through enclosing queries. */
  #resolve(fields: Node[], scope: Scope | undefined): Near {
    const names = fields.map((f) => f.String?.sval as string | undefined)
    if (names.some((n) => n === undefined)) return undefined
    const columnName = names.at(-1)!
    if (names.length === 1) {
      for (let s = scope; s; s = s.parent) {
        const holding = s.relations.filter((r) => r.fields?.has(columnName))
        if (holding.length === 1) return holding[0]!.fields!.get(columnName)
        if (holding.length > 1) return undefined
        if (s.relations.length && s.relations.every((r) => r.catalog)) return 'catalog'
        if (s.relations.some((r) => !r.fields && !r.catalog)) return undefined
      }
      return undefined
    }
    const relationName = names.at(-2)!
    const schema = names.length > 2 ? names.at(-3) : undefined
    for (let s = scope; s; s = s.parent) {
      const relation = s.relations.find((r) => (r.alias ?? r.name) === relationName && (!schema || r.schema === schema))
      if (relation) return relation.fields?.get(columnName) ?? (relation.catalog ? 'catalog' : undefined)
    }
    return undefined
  }
}

function uncast(node: Node | undefined): Node | undefined {
  let n = node
  while (n?.TypeCast) n = n.TypeCast.arg
  return n
}

function literal(node: Node | undefined): boolean {
  const n = uncast(node)
  return !!(n?.ParamRef || (n?.A_Const && !n.A_Const.isnull))
}

function column(node: Node | undefined): Node[] | undefined {
  return uncast(node)?.ColumnRef?.fields
}

/** The value of a constant: the text of a string, number or boolean. */
export function constValue(node: Node | undefined): string | number | boolean | undefined {
  if (!node) return undefined
  if (node.sval) return node.sval.sval ?? ''
  if (node.ival) return node.ival.ival ?? 0
  if (node.fval) return node.fval.fval
  if (node.boolval) return node.boolval.boolval ?? false
  return undefined
}

function milliseconds(node: Node | undefined): number | undefined {
  const value = constValue(node)
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/.exec(value)
  if (!m) return undefined
  const unit = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 'ms']!
  return Number(m[1]) * unit
}
