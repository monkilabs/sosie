import { randomBytes, randomInt } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Faker, RequestScope } from '@sosie/core'
import { analyze, parseStatements, type Analysis } from './guard.js'
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
  readHandshakeResponse,
  STATUS,
  textRow,
  type Column,
} from './protocol.js'
import { fakeRow, planColumns } from './results.js'
import { rewriteConsts } from './rewrite.js'
import type { Catalog } from './schema.js'
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

const UNREACHABLE = 'Sosie cannot reach its upstream database. The terminal running Sosie says why.'

/** Errors whose messages hold only what the client wrote and the schema: shown, with what Sosie substituted turned back. */
const SCHEMA_ERRORS = new Set([
  1044, 1045, 1046, 1049, 1051, 1052, 1054, 1060, 1064, 1065, 1109, 1142, 1143, 1146, 1149, 1222, 1227, 1235, 1248, 1250, 1267, 1271,
  1295, 1305, 1317, 1356, 1370, 1449, 1630, 1792, 3024,
])

/**
 * One client connection. Sosie answers the handshake itself, accepting any user without a password, then relays
 * each statement to a read-only session upstream: checked, its fakes turned back into real values on the way in,
 * and every value faked on the way out.
 */
export class Session {
  readonly id = randomInt(1, 2 ** 31 - 1)
  readonly #reader: PacketReader
  readonly #writer: PacketWriter
  #up: Upstream | undefined
  #database: string
  #status: number = STATUS.AUTOCOMMIT
  /** What Sosie has to say about the last statement, for SHOW WARNINGS. */
  #notes: string[] = []

  constructor(
    private readonly socket: Socket,
    private readonly ctx: SessionContext,
    database: string,
  ) {
    this.#reader = new PacketReader(socket)
    this.#writer = new PacketWriter(socket)
    this.#database = database
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
    try {
      this.#up = await Upstream.open(this.ctx.upstream, { statementTimeout: this.ctx.statementTimeout, maxRows: this.ctx.maxRows })
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
      case COMMAND.SET_OPTION:
        this.#write(eof(this.#status))
        return false
      case COMMAND.RESET_CONNECTION:
        await this.#up?.end().catch(() => {})
        this.#up = await Upstream.open(this.ctx.upstream, { statementTimeout: this.ctx.statementTimeout, maxRows: this.ctx.maxRows })
        this.#status = STATUS.AUTOCOMMIT
        this.#write(ok({ status: this.#status }))
        return false
      case COMMAND.STMT_CLOSE:
      case COMMAND.STMT_SEND_LONG_DATA:
        // No answer is expected.
        return false
      case COMMAND.STMT_PREPARE:
      case COMMAND.STMT_EXECUTE:
      case COMMAND.STMT_RESET:
        this.#write(err(1295, 'HY000', 'Sosie does not run prepared statements on MySQL yet: send each statement as text (in mysql2, query() rather than execute()).'))
        return false
      case COMMAND.CHANGE_USER:
        this.#write(err(1235, '42000', 'Sosie does not change the user of a session.'))
        return false
      default:
        this.#write(err(1047, '08S01', 'Unknown command'))
        return false
    }
  }

  async #query(text: string): Promise<void> {
    const notes = this.#notes
    this.#notes = []
    let statements
    try {
      statements = parseStatements(text)
    } catch (error) {
      return this.#write(err(1064, '42000', `You have an error in your SQL syntax, or one Sosie's parser does not read: ${String((error as Error).message ?? error).replace(/^sql parser error: /, '')}`))
    }
    if (!statements.length) return this.#write(err(1065, '42000', 'Query was empty'))
    if (statements.length > 1) return this.#write(err(1064, '42000', 'Sosie runs one statement per query: send them one at a time.'))
    const stmt = statements[0]!
    const analysis = analyze(stmt, text, this.ctx.catalog, this.#database, { statementTimeout: this.ctx.statementTimeout, maxRows: this.ctx.maxRows })
    if (analysis.refusal) return this.#write(err(analysis.refusal.code, analysis.refusal.sqlState, analysis.refusal.message))
    const scope = this.ctx.faker.request(text)
    const sql = analysis.catalogOnly ? text : (rewriteConsts(text, analysis.consts, scope) ?? text)
    let result: Result
    try {
      result = await this.#up!.run(sql)
    } catch (error) {
      if (!isUpstreamError(error)) throw error
      return this.#write(err(error.code, error.sqlState, this.#scrubbed(error.code, error.message, scope)))
    }
    this.#track(stmt)
    if (!result.columns) return this.#write(ok({ affected: result.affected ?? 0, status: this.#status, warnings: result.warnings }))
    if (analysis.answer === 'warnings') return this.#warnings(result, scope, notes)
    this.#rows(result, analysis, text, scope)
  }

  #rows(result: Result, analysis: Analysis, text: string, scope: RequestScope): void {
    const columns = result.columns!
    const plans = planColumns(columns, analysis, this.ctx.catalog)
    this.#header(columns)
    for (const row of result.rows ?? []) this.#write(textRow(fakeRow(row, plans, this.ctx.faker, text, scope)))
    if (result.capped) {
      this.#notes.push(`Sosie returned the first ${this.ctx.maxRows} rows; the rest were cut. Narrow the query, or start Sosie with a higher --max-rows.`)
    }
    this.#write(eof(this.#status, this.#notes.length))
  }

  /** SHOW WARNINGS and SHOW ERRORS: a message that may quote a row's value is hidden; Sosie's own notes come first. */
  #warnings(result: Result, scope: RequestScope, notes: string[]): void {
    const columns = result.columns!
    this.#header(columns)
    for (const note of notes) this.#write(textRow([Buffer.from('Note'), Buffer.from('1105'), Buffer.from(note)]))
    for (const row of result.rows ?? []) {
      const code = Number(row[1]?.toString() ?? 0)
      const message = row[2]?.toString() ?? ''
      this.#write(textRow([row[0] ?? null, row[1] ?? null, Buffer.from(this.#scrubbed(code, message, scope))]))
    }
    this.#write(eof(this.#status))
  }

  #header(columns: Column[]): void {
    this.#write(lenencInt(columns.length))
    for (const column of columns) this.#write(columnDefinition(column))
    this.#write(eof(this.#status))
  }

  /** What MySQL said, for the client: the schema's words shown, scrubbed of what Sosie substituted; anything else, its code. */
  #scrubbed(code: number, message: string, scope: RequestScope): string {
    if (SCHEMA_ERRORS.has(code)) return scope.scrub(message)
    return `Error ${code}: Sosie hides the rest of this message, which may quote a value from your rows.`
  }

  /** The session's database and transaction, as the statement that just ran left them. */
  #track(stmt: Record<string, unknown>): void {
    const [type, body] = Object.entries(stmt)[0] ?? []
    const b = body as Record<string, unknown> | undefined
    if (type === 'Use') {
      const names: string[] = []
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) n.forEach(walk)
        else if (n && typeof n === 'object') {
          const value = (n as { value?: unknown }).value
          if (typeof value === 'string') names.push(value)
          else Object.values(n).forEach(walk)
        }
      }
      walk(b)
      if (names.length) this.#database = names.at(-1)!
    } else if (type === 'StartTransaction') this.#status |= STATUS.IN_TRANS
    else if (type === 'Commit' || type === 'Rollback') this.#status &= ~STATUS.IN_TRANS
  }

  #write(payload: Buffer): void {
    this.#writer.write(payload)
  }
}

function isUpstreamError(error: unknown): error is UpstreamError {
  return !!error && typeof error === 'object' && 'code' in error && typeof (error as UpstreamError).code === 'number' && 'sqlState' in error
}

/** A name as MySQL quotes one. */
function identifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}
