import { randomBytes, randomInt } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Faker } from '@sosie/core'
import { ArgumentsError, binaryRow, lookupTexts, paramLiteral, readExecute, type Param } from './binary.js'
import { columnName, scrubbed, type Sent } from './errors.js'
import { analyze, parseStatements, type Analysis, type Limits, type Refusal } from './guard.js'
import {
  CLIENT,
  COMMAND,
  columnDefinition,
  eof,
  err,
  handshake,
  lenencInt,
  ok,
  PacketReader,
  PacketWriter,
  prepareOk,
  readHandshakeResponse,
  STATUS,
  textRow,
  type Column,
} from './protocol.js'
import { fakeRow, planColumns } from './results.js'
import { constSubstitutions, substitute, type Substitution } from './rewrite.js'
import type { Catalog } from './schema.js'
import { splitStatements } from './split.js'
import { Upstream, type Result, type UpstreamError } from './upstream.js'

export interface SessionContext {
  upstream: URL
  catalog: Catalog
  faker: Faker
  maxRows: number
  statementTimeout: number
  /** The upstream's version, which the greeting gives clients before the session upstream opens. */
  serverVersion: string
  /** A line for the terminal running Sosie, which may name the real host. */
  log: (line: string) => void
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the parse tree is sqlparser's JSON, untyped here. */
type Node = Record<string, any>

/** One statement of a query: its text, as sent upstream on its own, and its parse. */
interface Statement {
  text: string
  stmt: Node
}

/** A prepared statement: checked once, and run as text each time it executes, its parameters written in as literals. */
interface Prepared extends Statement {
  analysis: Analysis
  /** The database the session was in when it was checked. */
  database: string
  params: number
  /** The types the client bound last: an execution may send none, and use those. */
  types?: Buffer | undefined
  /** Data sent with COM_STMT_SEND_LONG_DATA, by parameter, until the next execution or reset. */
  long: Map<number, Buffer[]>
  longBytes: number
}

const UNREACHABLE = 'Sosie cannot reach its upstream database. The terminal running Sosie says why.'

/** The status flags a session takes from the server: whether it commits each statement, and is in a transaction. */
const TRANSACTION = STATUS.IN_TRANS | STATUS.AUTOCOMMIT | STATUS.IN_TRANS_READONLY

/** MySQL's own cap on prepared statements, max_prepared_stmt_count's default: Sosie's, per session. */
const MAX_PREPARED = 16_382

/** MySQL's max_allowed_packet default: the most data COM_STMT_SEND_LONG_DATA may send for one execution. */
const MAX_LONG_DATA = 64 * 1024 * 1024

const BAD_ARGUMENTS = err(1210, 'HY000', 'Incorrect arguments to mysqld_stmt_execute')
const PARAMS_DIFFER = 'Sosie reads the parameters (?) of this statement differently from MySQL: send it as text, its values in it.'

/**
 * One client connection. Sosie answers the handshake itself, accepting any user without a password, then relays
 * each statement to a read-only session upstream: checked, its fakes turned back into real values on the way in,
 * and every value faked on the way out. A prepared statement runs the same way, as text, its parameters written in.
 */
export class Session {
  readonly id = randomInt(1, 2 ** 31 - 1)
  readonly #reader: PacketReader
  readonly #writer: PacketWriter
  #up: Upstream | undefined
  #database: string
  #status: number = STATUS.AUTOCOMMIT
  /** Whether the client turned on several statements per query. */
  #multi = false
  /** What Sosie has to say about the last statement, for SHOW WARNINGS. */
  #notes: string[] = []
  /** The last statement sent upstream: SHOW WARNINGS shows its warnings, scrubbed of what was substituted in it. */
  #last: Sent | undefined
  readonly #prepared = new Map<number, Prepared>()
  #nextId = 1

  constructor(
    private readonly socket: Socket,
    private readonly ctx: SessionContext,
    database: string,
  ) {
    this.#reader = new PacketReader(socket)
    this.#writer = new PacketWriter(socket)
    this.#database = database
  }

  get #limits(): Limits {
    return { statementTimeout: this.ctx.statementTimeout, maxRows: this.ctx.maxRows }
  }

  async run(): Promise<void> {
    try {
      if (!(await this.#handshake())) return
      for (;;) {
        const packet = await this.#reader.next()
        if (!packet) break
        this.#writer.seq = packet.seq + 1
        if (await this.#command(packet.payload)) break
      }
    } catch (error) {
      this.ctx.log(`Upstream session ended: ${(error as Error).message}`)
      this.#write(err(2013, 'HY000', 'The upstream session ended.'))
    } finally {
      await this.#up?.end().catch(() => {})
      this.socket.end()
    }
  }

  async #handshake(): Promise<boolean> {
    // A scramble of printable bytes: the greeting ends it with a NUL. Sosie never checks what a client signs with it.
    const scramble = Buffer.from(Array.from(randomBytes(20), (b) => 33 + (b % 94)))
    this.#writer.seq = 0
    this.#write(handshake(this.id, this.ctx.serverVersion, scramble))
    const response = await this.#reader.next()
    if (!response) return false
    this.#writer.seq = response.seq + 1
    const hello = readHandshakeResponse(response.payload)
    if (!(hello.capabilities & CLIENT.PROTOCOL_41) || hello.ssl) {
      this.#write(err(1045, '28000', hello.ssl ? 'Sosie does not speak TLS on its local address: connect without it.' : 'Sosie needs protocol 4.1.'))
      return false
    }
    this.#multi = (hello.capabilities & CLIENT.MULTI_STATEMENTS) !== 0
    try {
      this.#up = await Upstream.open(this.ctx.upstream, this.#limits)
    } catch (error) {
      this.ctx.log(`Cannot open an upstream session: ${(error as Error).message}`)
      this.#write(err(2003, 'HY000', UNREACHABLE))
      return false
    }
    if (hello.database && hello.database !== this.#database) {
      try {
        await this.#up.run(`USE ${identifier(hello.database)}`)
        this.#database = hello.database
      } catch {
        this.#write(err(1049, '42000', `Unknown database '${hello.database}'`))
        return false
      }
    }
    this.#write(ok({ status: this.#status }))
    return true
  }

  /** One command; true when the client is done. */
  async #command(payload: Buffer): Promise<boolean> {
    switch (payload[0]) {
      case COMMAND.QUIT:
        return true
      case COMMAND.PING:
        this.#write(ok({ status: this.#status }))
        return false
      case COMMAND.QUERY:
        await this.#query(payload.subarray(1).toString('utf8'))
        return false
      case COMMAND.INIT_DB:
        await this.#query(`USE ${identifier(payload.subarray(1).toString('utf8'))}`)
        return false
      case COMMAND.FIELD_LIST:
        // Deprecated, and only for completion in the mysql client: no columns.
        this.#write(eof(this.#status))
        return false
      case COMMAND.STATISTICS:
        this.#write(Buffer.from('Sosie: a read-only MySQL endpoint that fakes every value.'))
        return false
      case COMMAND.SET_OPTION: {
        const option = payload.length >= 3 ? payload.readUInt16LE(1) : -1
        if (option !== 0 && option !== 1) {
          this.#write(err(1047, '08S01', 'Unknown command'))
          return false
        }
        this.#multi = option === 0
        this.#write(eof(this.#status))
        return false
      }
      case COMMAND.RESET_CONNECTION:
        await this.#reset()
        return false
      case COMMAND.STMT_PREPARE:
        await this.#prepare(payload.subarray(1).toString('utf8'))
        return false
      case COMMAND.STMT_EXECUTE:
        await this.#execute(payload)
        return false
      case COMMAND.STMT_SEND_LONG_DATA:
        // No answer is expected: an error waits for the execution.
        this.#longData(payload)
        return false
      case COMMAND.STMT_CLOSE:
        // No answer is expected.
        if (payload.length >= 5) this.#prepared.delete(payload.readUInt32LE(1))
        return false
      case COMMAND.STMT_RESET: {
        const prepared = this.#statement(payload, 'mysqld_stmt_reset')
        if (!prepared) return false
        prepared.long.clear()
        prepared.longBytes = 0
        this.#write(ok({ status: this.#status }))
        return false
      }
      case COMMAND.STMT_FETCH: {
        // Sosie opens no cursor: an execution that asked for one was answered with its rows.
        const prepared = this.#statement(payload, 'mysqld_stmt_fetch')
        if (prepared) this.#write(err(1421, 'HY000', `The statement (${payload.readUInt32LE(1)}) has no open cursor.`))
        return false
      }
      case COMMAND.CHANGE_USER:
        this.#write(err(1235, '42000', 'Sosie does not change the user of a session.'))
        return false
      default:
        this.#write(err(1047, '08S01', 'Unknown command'))
        return false
    }
  }

  /**
   * A new session upstream, as MySQL resets one: settings, variables, prepared statements and transaction gone, the
   * database kept. The guard reads names in the database the session is in, so the session upstream is put in it too.
   */
  async #reset(): Promise<void> {
    await this.#up?.end().catch(() => {})
    this.#up = await Upstream.open(this.ctx.upstream, this.#limits)
    this.#status = STATUS.AUTOCOMMIT
    this.#notes = []
    this.#last = undefined
    this.#prepared.clear()
    const named = decodeURIComponent(this.ctx.upstream.pathname.slice(1))
    if (this.#database !== named) {
      try {
        await this.#up.run(`USE ${identifier(this.#database)}`)
      } catch {
        this.#database = named
      }
    }
    this.#write(ok({ status: this.#status }))
  }

  /* Statements as text. */

  async #query(text: string): Promise<void> {
    let statements: Node[]
    try {
      statements = parseStatements(text)
    } catch (error) {
      return this.#write(syntaxError(error))
    }
    if (!statements.length) return this.#write(err(1065, '42000', 'Query was empty'))
    let pieces: Statement[] = [{ text, stmt: statements[0]! }]
    if (statements.length > 1) {
      if (!this.#multi) {
        return this.#write(err(1064, '42000', 'This query has several statements, and the client did not turn on multiple statements: send them one at a time.'))
      }
      const split = this.#split(text, statements.length)
      if (!split) return this.#write(err(1064, '42000', 'Sosie cannot tell where each statement of this query ends: send them one at a time.'))
      pieces = split
    }
    // Every statement is checked before the first runs: one Sosie refuses stops them all. A USE among them changes
    // the database the next are read in, as it will when they run.
    const analyses: Analysis[] = []
    let database = this.#database
    for (const piece of pieces) {
      const analysis = analyze(piece.stmt, piece.text, this.ctx.catalog, database, this.#limits)
      if (analysis.refusal) return this.#write(refused(analysis.refusal))
      analyses.push(analysis)
      database = usedDatabase(piece.stmt) ?? database
    }
    for (const [i, piece] of pieces.entries()) {
      if (!(await this.#run(piece, analyses[i]!, { more: i < pieces.length - 1 }))) return
    }
  }

  /** The query's statements, each with its own text; undefined where the split and the parse do not agree. */
  #split(text: string, count: number): Statement[] | undefined {
    const out: Statement[] = []
    for (const piece of splitStatements(text)) {
      let parsed: Node[]
      try {
        parsed = parseStatements(piece)
      } catch {
        return undefined
      }
      if (parsed.length > 1) return undefined
      if (parsed.length === 1) out.push({ text: piece, stmt: parsed[0]! })
    }
    return out.length === count ? out : undefined
  }

  /* Prepared statements. */

  async #prepare(text: string): Promise<void> {
    let statements: Node[]
    try {
      statements = parseStatements(text)
    } catch (error) {
      return this.#write(syntaxError(error))
    }
    if (!statements.length) return this.#write(err(1065, '42000', 'Query was empty'))
    if (statements.length > 1) return this.#write(err(1064, '42000', 'A prepared statement is one statement.'))
    if (this.#prepared.size >= MAX_PREPARED) {
      return this.#write(err(1461, '42000', `Can't create more than max_prepared_stmt_count statements (current value: ${MAX_PREPARED})`))
    }
    const stmt = statements[0]!
    const analysis = analyze(stmt, text, this.ctx.catalog, this.#database, this.#limits)
    if (analysis.refusal) return this.#write(refused(analysis.refusal))
    if (analysis.placeholders.some((at) => text[at] !== '?')) return this.#write(err(1235, '42000', PARAMS_DIFFER))
    // MySQL says what the statement returns, and how many parameters it has, without running it.
    const scope = this.ctx.faker.request(text)
    const rewritten = analysis.catalogOnly ? undefined : substitute(text, constSubstitutions(analysis.consts, scope))
    const sent: Sent = { text, sql: rewritten?.sql ?? text, edits: rewritten?.edits ?? [], scope }
    let described: { columns: Column[]; params: Column[] }
    try {
      described = await this.#up!.prepare(sent.sql)
    } catch (error) {
      if (!isUpstreamError(error)) throw error
      return this.#write(err(error.code, error.sqlState, scrubbed(error.code, error.message, sent, this.ctx.catalog)))
    }
    // Each parameter's value is written where Sosie read a ?: were MySQL to read them elsewhere, it would not run.
    if (described.params.length !== analysis.placeholders.length) return this.#write(err(1235, '42000', PARAMS_DIFFER))
    const id = this.#nextId++
    this.#prepared.set(id, { text, stmt, analysis, database: this.#database, params: described.params.length, long: new Map(), longBytes: 0 })
    this.#write(prepareOk(id, described.columns.length, described.params.length))
    if (described.params.length) {
      for (const param of described.params) this.#write(columnDefinition(param))
      this.#write(eof(this.#status))
    }
    if (described.columns.length) {
      for (const column of described.columns) this.#write(columnDefinition(this.#named(column, sent)))
      this.#write(eof(this.#status))
    }
  }

  async #execute(payload: Buffer): Promise<void> {
    const prepared = this.#statement(payload, 'mysqld_stmt_execute')
    if (!prepared) return
    const long = prepared.longBytes > MAX_LONG_DATA ? undefined : prepared.long
    let params: Param[]
    try {
      if (!long) throw new ArgumentsError()
      const execute = readExecute(payload, prepared.params, prepared.types, long)
      prepared.types = execute.types
      params = execute.params
    } catch (error) {
      if (!(error instanceof ArgumentsError)) throw error
      return this.#write(BAD_ARGUMENTS)
    } finally {
      prepared.long.clear()
      prepared.longBytes = 0
    }
    let analysis = prepared.analysis
    if (prepared.database !== this.#database) {
      // It runs in the database the session is in now: checked again there.
      analysis = analyze(prepared.stmt, prepared.text, this.ctx.catalog, this.#database, this.#limits)
      if (analysis.refusal) return this.#write(refused(analysis.refusal))
    }
    await this.#run(prepared, analysis, { params, binary: true })
  }

  #longData(payload: Buffer): void {
    if (payload.length < 7) return
    const prepared = this.#prepared.get(payload.readUInt32LE(1))
    const param = payload.readUInt16LE(5)
    if (!prepared || param >= prepared.params) return
    prepared.longBytes += payload.length - 7
    // Past the cap, the data is dropped and the execution fails, as MySQL's does past max_allowed_packet.
    if (prepared.longBytes > MAX_LONG_DATA) return
    const parts = prepared.long.get(param) ?? []
    parts.push(Buffer.from(payload.subarray(7)))
    prepared.long.set(param, parts)
  }

  /** The prepared statement a command names; an error written when there is none. */
  #statement(payload: Buffer, command: string): Prepared | undefined {
    const id = payload.length >= 5 ? payload.readUInt32LE(1) : 0
    const prepared = this.#prepared.get(id)
    if (!prepared) this.#write(err(1243, 'HY000', `Unknown prepared statement handler (${id}) given to ${command}`))
    return prepared
  }

  /* Shared: one statement, run and answered. */

  /**
   * Turn back the fakes in a statement, write in its parameters, run it upstream and answer: in text, or for a
   * prepared statement in binary. With `more`, another result follows. False when it failed, an error written.
   */
  async #run(statement: Statement, analysis: Analysis, { params, binary = false, more = false }: { params?: Param[]; binary?: boolean; more?: boolean }): Promise<boolean> {
    const notes = this.#notes
    this.#notes = []
    const shown = params?.map((p, i) => lookupTexts(p, analysis.params.get(i + 1))[0]).filter((t) => t !== undefined) ?? []
    const scope = this.ctx.faker.request([statement.text, ...shown].join('\n'))
    const substitutions: Substitution[] = analysis.catalogOnly ? [] : constSubstitutions(analysis.consts, scope)
    for (const [i, at] of (params ? analysis.placeholders : []).entries()) {
      const param = params![i]!
      const near = analysis.params.get(i + 1)
      let real: string | undefined
      // A parameter compared with a column may be a fake the client saw: it goes upstream as the real value.
      if (!analysis.catalogOnly && analysis.params.has(i + 1) && near !== 'catalog') {
        for (const text of lookupTexts(param, near)) {
          const found = scope.lookup(text, near)
          if (found !== undefined && found !== text) {
            real = found
            break
          }
        }
      }
      const literal = paramLiteral(param, real, near)
      if (literal === undefined) {
        this.#write(BAD_ARGUMENTS)
        return false
      }
      substitutions.push({ start: at, end: at + 1, literal })
    }
    const rewritten = substitute(statement.text, substitutions)
    const sent: Sent = { text: statement.text, sql: rewritten?.sql ?? statement.text, edits: rewritten?.edits ?? [], scope }
    // SHOW WARNINGS shows the warnings of the statement before it, and leaves them for the next.
    const warnings = analysis.answer === 'warnings'
    const of = (warnings && this.#last) || sent
    if (!warnings) this.#last = sent
    let result: Result
    try {
      result = await this.#up!.run(sent.sql)
    } catch (error) {
      if (!isUpstreamError(error)) throw error
      this.#write(err(error.code, error.sqlState, scrubbed(error.code, error.message, of, this.ctx.catalog)))
      return false
    }
    this.#database = usedDatabase(statement.stmt) ?? this.#database
    if (result.status !== undefined) this.#status = (this.#status & ~TRANSACTION) | (result.status & TRANSACTION)
    // Without autocommit, a statement that reads a table starts a transaction, as the server says at its rows' end.
    else if (!(this.#status & STATUS.AUTOCOMMIT) && !analysis.catalogOnly) this.#status |= STATUS.IN_TRANS
    const status = this.#status | (more ? STATUS.MORE_RESULTS : 0)
    if (!result.columns) {
      this.#write(ok({ affected: result.affected ?? 0, status, warnings: result.warnings }))
      return true
    }
    const columns = result.columns
    const row = binary ? (values: (Buffer | null)[]) => binaryRow(values, columns) : textRow
    if (warnings) this.#warnings(result, of, notes, row, status)
    else this.#rows(result, analysis, sent, row, status)
    return true
  }

  #rows(result: Result, analysis: Analysis, sent: Sent, row: (values: (Buffer | null)[]) => Buffer, status: number): void {
    const columns = result.columns!
    const plans = planColumns(columns, analysis, this.ctx.catalog)
    this.#header(columns, sent)
    for (const values of result.rows ?? []) this.#write(row(fakeRow(values, plans, this.ctx.faker, sent.text, sent.scope)))
    if (result.capped) {
      this.#notes.push(`Sosie returned the first ${this.ctx.maxRows} rows; the rest were cut. Narrow the query, or raise max-rows in sosie.yml.`)
    }
    this.#write(eof(status, this.#notes.length))
  }

  /**
   * SHOW WARNINGS and SHOW ERRORS, of the statement before: a message that may quote a row's value is hidden, and
   * the rest scrubbed of what was substituted in that statement. Sosie's own notes come first.
   */
  #warnings(result: Result, of: Sent, notes: string[], row: (values: (Buffer | null)[]) => Buffer, status: number): void {
    this.#header(result.columns!)
    for (const note of notes) this.#write(row([Buffer.from('Note'), Buffer.from('1105'), Buffer.from(note)]))
    for (const values of result.rows ?? []) {
      const code = Number(values[1]?.toString() ?? 0)
      const message = values[2]?.toString() ?? ''
      this.#write(row([values[0] ?? null, values[1] ?? null, Buffer.from(scrubbed(code, message, of, this.ctx.catalog))]))
    }
    this.#write(eof(status))
  }

  #header(columns: Column[], sent?: Sent): void {
    this.#write(lenencInt(columns.length))
    for (const column of columns) this.#write(columnDefinition(sent ? this.#named(column, sent) : column))
    this.#write(eof(this.#status))
  }

  /** A column as the client sees it: a computed column's name in the client's text, never with a real value Sosie put in it. */
  #named(column: Column, sent: Sent): Column {
    return {
      ...column,
      name: columnName(column.name, sent, this.ctx.catalog),
      orgName: column.orgTable ? column.orgName : columnName(column.orgName, sent, this.ctx.catalog),
    }
  }

  #write(payload: Buffer): void {
    this.#writer.write(payload)
  }
}

/** The database a USE statement names, as the session is left in it. */
function usedDatabase(stmt: Node): string | undefined {
  const [type, body] = Object.entries(stmt)[0] ?? []
  if (type !== 'Use') return undefined
  const names: string[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const value = (n as { value?: unknown }).value
      if (typeof value === 'string') names.push(value)
      else Object.values(n).forEach(walk)
    }
  }
  walk(body)
  return names.at(-1)
}

function syntaxError(error: unknown): Buffer {
  return err(1064, '42000', `You have an error in your SQL syntax, or one Sosie's parser does not read: ${String((error as Error).message ?? error).replace(/^sql parser error: /, '')}`)
}

function refused(refusal: Refusal): Buffer {
  return err(refusal.code, refusal.sqlState, refusal.message)
}

function isUpstreamError(error: unknown): error is UpstreamError {
  return !!error && typeof error === 'object' && 'code' in error && typeof (error as UpstreamError).code === 'number' && 'sqlState' in error
}

/** A name as MySQL quotes one. */
function identifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}
