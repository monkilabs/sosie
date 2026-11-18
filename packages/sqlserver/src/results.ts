import type { Faker, Field, FieldType, Value } from '@sosie/core'
import { scrubbed, type Sent } from './errors.js'
import type { Analysis, Target } from './guard.js'
import { resolveTable, type Catalog } from './schema.js'
import {
  COLINFO,
  colMetadata,
  done as doneToken,
  ENV,
  message,
  NULLABLE,
  order,
  readTokens,
  returnValue,
  row,
  TOKEN,
  withFlags,
  type Column,
  type ColumnInfo,
  type Token,
} from './tokens.js'
import { bytesOf, fieldTypeOf, textOf, TYPE, type RawValue } from './types.js'

/** How one result column is faked. */
export type ColumnPlan = { pass: true } | { field: Field } | { type: FieldType } | { json: true }

/** The server's name in the messages clients see: never the upstream's, which says where the database is. */
export const SERVER_NAME = 'Sosie'

/** FOR JSON writes its text in rows of this many characters at most. */
const JSON_CHUNK = 2033

/** ENVCHANGEs a client is told: the rest say where the server is, or what only Sosie's own session negotiated. */
const PASSED_ENV = new Set<number>([
  ENV.DATABASE, ENV.LANGUAGE, ENV.CHARSET, ENV.SORT_LOCALE, ENV.SORT_FLAGS, ENV.COLLATION, ENV.BEGIN_TRAN, ENV.COMMIT_TRAN,
  ENV.ROLLBACK_TRAN, ENV.DEFECT_TRAN, ENV.TRAN_ENDED, ENV.RESET_ACK,
])

const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema'])

export interface Request {
  /** One per RPC call, or one for a batch: each applies to the result sets until its call's DONEPROC. */
  analyses: Analysis[]
  sent: (Sent | undefined)[]
  /** The ordinals of the output parameters that are statement handles (sp_prepare's): they pass. */
  handles: Set<number>[]
}

export interface ReplyContext {
  catalog: Catalog
  faker: Faker
  maxRows: number
  /** The database the session is in: a table named without one is in it. */
  database: string
}

export interface Rewritten {
  payload: Buffer
  /** The database the reply left the session in, where it changed it. */
  database?: string
  /** The statement handles the reply returned, by call. */
  handles: Map<number, number>
  /** The reply's metadata, for a reply after it that reuses it (an RPC with fNoMetaData). */
  columns: Column[]
}

interface ResultSet {
  columns: Column[]
  tables?: string[][]
  infos?: ColumnInfo[]
  ordered?: number[]
  /** Indexes of the columns a client sees: all but browse mode's hidden ones. */
  visible: number[]
  plans: ColumnPlan[]
  shown: Column[]
  started: boolean
  rows: number
  capped: boolean
  json: string[]
}

/**
 * A reply as the client gets it: every value faked by the field browse mode says it came from, or by its type; browse
 * mode's tables, column info and hidden keys gone; messages scrubbed; and rows past the cap dropped, with a note.
 */
export function rewriteReply(payload: Buffer, request: Request, ctx: ReplyContext, previous: Column[] = []): Rewritten {
  const out: Buffer[] = []
  const handles = new Map<number, number>()
  let call = 0
  let shapeAt = 0
  /**
   * The guard counted the result sets its statements give, in order. A statement that fails gives none, and the sets
   * after it would take the shapes of the ones before: a computed value read as a count or a literal. So once a call
   * has an error, its sets are faked as though the guard had said nothing.
   */
  let lost = false
  let database: string | undefined
  let set: ResultSet | undefined
  let columns = previous
  const analysis = () => request.analyses[Math.min(call, request.analyses.length - 1)]!
  const sent = () => request.sent[Math.min(call, request.sent.length - 1)]

  const start = () => {
    if (!set || set.started) return
    set.started = true
    const hidden = new Set((set.infos ?? []).filter((i) => i.status & COLINFO.HIDDEN).map((i) => i.column - 1))
    set.visible = set.columns.map((_, i) => i).filter((i) => !hidden.has(i))
    const shape = lost ? undefined : analysis().shapes?.[shapeAt++]
    const targets = expand(shape?.targets, set.visible.length)
    set.plans = set.visible.map((i, at) => plan(set!, i, targets?.[at], shape?.json ?? false, analysis(), ctx, database ?? ctx.database))
    // A column faked as null says it may be null, whatever the table says.
    set.shown = set.visible.map((i, at) => {
      const column = set!.columns[i]!
      const p = set!.plans[at]!
      const unknown = !('pass' in p) && (fieldTypeOf(column.type).kind === 'unknown' || ('field' in p && p.field.type.kind === 'unknown'))
      return unknown ? withFlags(column, column.flags | NULLABLE) : column
    })
    out.push(colMetadata(set.shown))
    if (set.ordered) {
      const ordinal = new Map(set.visible.map((i, at) => [i + 1, at + 1]))
      // The rows are ordered by the columns before the first hidden one: after it, only within each of its values.
      const hidden = set.ordered.findIndex((n) => !ordinal.has(n))
      const kept = set.ordered.slice(0, hidden < 0 ? undefined : hidden).map((n) => ordinal.get(n)!)
      // ORDER BY a hidden key first: no ORDER at all, as ODBC reads an empty one as a broken stream.
      if (kept.length) out.push(order(kept))
    }
  }

  const end = (t: Extract<Token, { kind: 'done' }>) => {
    if (!set) return t.raw
    start()
    let rows = t.rows
    if (set.json.length) {
      const text = set.json.join('')
      const fake = ctx.faker.computed(text, { kind: 'json' }, sent()?.text ?? '', sent()?.scope)
      const faked = fake === null ? '' : String(fake)
      const chunks = faked.match(new RegExp(`[\\s\\S]{1,${JSON_CHUNK}}`, 'g')) ?? []
      for (const chunk of chunks) out.push(row(set.shown, [{ bytes: Buffer.from(chunk, 'utf16le') }]))
      rows = BigInt(chunks.length)
    } else if (set.capped) {
      rows = BigInt(ctx.maxRows)
      out.push(
        message({
          error: false,
          number: 50000,
          state: 1,
          severity: 0,
          text: `Sosie returned the first ${ctx.maxRows} rows; the rest were cut. Narrow the query, or raise max-rows in sosie.yml.`,
          server: SERVER_NAME,
          proc: '',
          line: 1,
        }),
      )
    }
    set = undefined
    return t.status & 0x10 ? doneToken(t.status, rows, t.token, t.curcmd) : t.raw
  }

  for (const t of readTokens(payload, columns)) {
    if (set && !set.started && t.kind !== 'tabname' && t.kind !== 'colinfo' && t.kind !== 'order') start()
    switch (t.kind) {
      case 'colmetadata':
        if (t.columns) columns = t.columns
        set = { columns, visible: [], plans: [], shown: [], started: false, rows: 0, capped: false, json: [] }
        break
      case 'tabname':
        if (set) set.tables = t.tables
        break
      case 'colinfo':
        if (set) set.infos = t.infos
        break
      case 'order':
        if (set) set.ordered = t.columns
        else out.push(t.raw)
        break
      case 'row': {
        if (!set) break
        const plans = set.plans
        if (plans.length === 1 && 'json' in plans[0]!) {
          const value = t.values[set.visible[0]!]!
          if (value.bytes) set.json.push(value.bytes.toString('utf16le'))
          break
        }
        if (set.rows >= ctx.maxRows) {
          set.capped = true
          break
        }
        set.rows++
        out.push(row(set.shown, set.visible.map((i, at) => fakeValue(set!.columns[i]!, plans[at]!, t.values[i]!, ctx.faker, sent()))))
        break
      }
      case 'done':
        out.push(end(t))
        if (t.token === TOKEN.DONEPROC) {
          call++
          shapeAt = 0
          lost = false
        }
        break
      case 'message':
        if (t.error) lost = true
        out.push(
          message({
            ...t,
            text: scrubbed(t.number, t.text, sent(), ctx.catalog),
            server: SERVER_NAME,
          }),
        )
        break
      case 'envchange':
        if (!PASSED_ENV.has(t.type)) break
        if (t.type === ENV.DATABASE) database = t.data.subarray(2, 2 + (t.data[1] ?? 0) * 2).toString('utf16le')
        out.push(t.raw)
        break
      case 'returnvalue': {
        const isHandle = request.handles[Math.min(call, request.handles.length - 1)]?.has(t.ordinal)
        if (isHandle) {
          if (t.value.bytes?.length === 4) handles.set(call, t.value.bytes.readInt32LE())
          out.push(t.raw)
        } else {
          // An output parameter holds whatever the statement put in it, a value from a row among them: faked by its type.
          out.push(returnValue(t, fakeValue({ userType: 0, flags: 0, type: t.type, name: t.name, raw: t.raw }, { type: fieldTypeOf(t.type) }, t.value, ctx.faker, sent())))
        }
        break
      }
      default:
        out.push(t.raw)
    }
  }
  return { payload: Buffer.concat(out), ...(database !== undefined && { database }), handles, columns }
}

/**
 * Which field a result column came from. Browse mode names each column's table and name, through aliases, joins,
 * views, synonyms and functions: such a column is faked by its field. One that is an expression, or has no table
 * (a literal, FOR JSON), rests on the guard's reading: it passes only when the batch reads no table of yours, or
 * when it is a count or a literal the client wrote. A table Sosie does not know is faked by type.
 */
function plan(set: ResultSet, i: number, target: Target | undefined, json: boolean, analysis: Analysis, ctx: ReplyContext, database: string): ColumnPlan {
  const column = set.columns[i]!
  const info = set.infos?.find((n) => n.column === i + 1)
  if (info && !(info.status & COLINFO.EXPRESSION) && info.table > 0) {
    const parts = set.tables?.[info.table - 1] ?? []
    const relation = resolveTable(parts, ctx.catalog, database)
    const field = relation?.byName.get((info.name ?? column.name).toLowerCase())
    if (field) return { field }
    if (isSystem(parts) || analysis.catalogOnly) return { pass: true }
    return { type: fieldTypeOf(column.type) }
  }
  if (analysis.catalogOnly) return { pass: true }
  if (json && set.columns.length === 1) return { json: true }
  // count(…) holds no value from a row, nor does a literal the client wrote.
  if (target === 'count' && (column.type.id === TYPE.INTN || column.type.id === TYPE.INT4 || column.type.id === TYPE.INT8)) return { pass: true }
  if (target === 'constant') return { pass: true }
  return { type: fieldTypeOf(column.type) }
}

/**
 * SQL Server's catalog, by its schema: sys and INFORMATION_SCHEMA, in any database. Not by database: browse mode names
 * a view's table as the view's text wrote it (dbo.users), so from master a table of yours would look like master's.
 */
function isSystem(parts: readonly string[]): boolean {
  return SYSTEM_SCHEMAS.has((parts.length >= 2 ? parts.at(-2)! : '').toLowerCase())
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

/** One value faked, in its column's type. A value of a type the core cannot fake is null; a fake that is no value of the type, its type's zero. */
export function fakeValue(column: Column, p: ColumnPlan, value: RawValue, faker: Faker, sent: Sent | undefined): RawValue {
  if (value.bytes === null || 'pass' in p || 'json' in p) return value
  const text = textOf(column.type, value.bytes)
  if (text === undefined) return { bytes: null }
  const fake: Value = 'field' in p ? faker.value(text, p.field, sent?.scope) : faker.computed(text, p.type, sent?.text ?? '', sent?.scope)
  if (fake === null || Array.isArray(fake)) return column.type.layout === 'fixed' ? { bytes: Buffer.alloc(column.type.length) } : { bytes: null }
  const bytes = bytesOf(column.type, fake, value.bytes)
  if (bytes) return { bytes, ...(value.pointer && { pointer: value.pointer }) }
  return column.type.layout === 'fixed' ? { bytes: Buffer.alloc(column.type.length) } : { bytes: null }
}
