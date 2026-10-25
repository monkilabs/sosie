import { randomInt } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Faker, RequestScope } from '@sosie/core'
import { analyze, parseStatements, type Analysis, type Parsed } from './guard.js'
import { backend, Reader, type ColumnDescription, type FrontendMessage, type Report } from './protocol.js'
import { fakeRow, planColumns, type ColumnPlan } from './results.js'
import { print, rewriteConsts, rewriteParam } from './rewrite.js'
import type { Catalog } from './schema.js'
import { Upstream, type UpstreamMessage } from './upstream.js'

export interface SessionContext {
  upstream: URL
  catalog: Catalog
  faker: Faker
  maxRows: number
  statementTimeout: number
  /** A line for the terminal running Sosie, which may name the real host. */
  log: (line: string) => void
  /** A client asks to cancel the statement of the session with this key. */
  cancel: (pid: number, secret: number) => void
}

interface Prepared {
  /** As the client sent it. */
  sent: string
  /** As it went upstream. */
  text: string
  analysis: Analysis
  scope: RequestScope
}

interface Portal {
  prepared: Prepared
  scope: RequestScope
  columns?: ColumnDescription[]
  plans?: ColumnPlan[]
  /** Rows returned so far, against the cap. */
  returned: number
  capped: boolean
}

/** Stops a request: Sosie's own refusal, or an upstream error already relayed. */
class Stop extends Error {}

const EMPTY: Analysis = { catalogOnly: true, command: 'SELECT', consts: [], params: new Map() }
const FATAL_UNREACHABLE = 'Sosie cannot reach its upstream database. The terminal running Sosie says why.'

/**
 * One client connection. Sosie answers the start-up itself, then relays each
 * message to a read-only session upstream: statements are checked and their
 * fakes turned back into real values on the way in, and every value is faked
 * on the way out.
 */
export class Session {
  readonly pid = randomInt(1, 2 ** 31 - 1)
  readonly secret = randomInt(1, 2 ** 31 - 1)
  readonly #socket: Socket
  readonly #reader: Reader
  readonly #ctx: SessionContext
  #up: Upstream | undefined
  readonly #statements = new Map<string, Prepared>()
  readonly #portals = new Map<string, Portal>()
  #skipping = false
  /** Since the last Sync: Sosie refused something, or upstream reported an error. */
  #refused = false
  #failed = false

  constructor(socket: Socket, ctx: SessionContext) {
    this.#socket = socket
    this.#ctx = ctx
    this.#reader = new Reader(socket)
  }

  /** Ask upstream to cancel the statement this session is running. */
  cancel(): void {
    this.#up?.cancel()
  }

  async run(): Promise<void> {
    try {
      if (!(await this.#startup())) return
      for (;;) {
        const message = await this.#reader.next()
        if (!message || message.type === 'terminate') break
        await this.#handle(message)
      }
    } catch (error) {
      if (!(error instanceof Stop)) {
        this.#write(backend.error({ severity: 'FATAL', code: '08006', message: 'The upstream session ended.' }))
        this.#ctx.log(`Upstream session ended: ${(error as Error).message}`)
      }
    } finally {
      await this.#up?.end()
      this.#socket.end()
    }
  }

  async #startup(): Promise<boolean> {
    let startup: Extract<FrontendMessage, { type: 'startup' }> | undefined
    while (!startup) {
      const message = await this.#reader.next()
      if (!message) return false
      if (message.type === 'ssl' || message.type === 'gss') this.#socket.write('N')
      else if (message.type === 'startup') startup = message
      else {
        if (message.type === 'cancel') this.#ctx.cancel(message.pid, message.secret)
        return false
      }
    }
    try {
      this.#up = await Upstream.open(this.#ctx.upstream, { statementTimeout: this.#ctx.statementTimeout })
    } catch (error) {
      this.#ctx.log(`Cannot open an upstream session: ${(error as Error).message}`)
      this.#write(backend.error({ severity: 'FATAL', code: '08006', message: FATAL_UNREACHABLE }))
      return false
    }
    const unrecognized = Object.keys(startup.params).filter((k) => k.startsWith('_pq_.'))
    if (startup.minor > 0 || unrecognized.length) this.#write(backend.negotiateProtocolVersion(0, unrecognized))
    this.#write(backend.authenticationOk())
    const parameters = new Map(this.#up.parameters)
    parameters.set('session_authorization', startup.params.user ?? 'sosie')
    if (startup.params.application_name) parameters.set('application_name', startup.params.application_name)
    for (const [name, value] of parameters) this.#write(backend.parameterStatus(name, value))
    this.#write(backend.backendKeyData(this.pid, this.secret))
    this.#write(backend.readyForQuery('I'))
    return true
  }

  async #handle(message: FrontendMessage): Promise<void> {
    if (message.type === 'query') return this.#simple(message.text)
    if (message.type === 'sync') return this.#sync()
    if (message.type === 'flush') return
    if (this.#skipping) return
    try {
      switch (message.type) {
        case 'parse':
          return await this.#parse(message.name, message.text, message.types)
        case 'bind':
          return await this.#bind(message)
        case 'describe':
          return await this.#describe(message.kind, message.name)
        case 'execute':
          return await this.#execute(message.portal, message.maxRows)
        case 'close':
          return await this.#close(message.kind, message.name)
        default:
          return this.#refuse({
            code: '0A000',
            message: `Sosie does not support this message (${message.type === 'unsupported' ? message.code : message.type}): only queries.`,
          })
      }
    } catch (error) {
      if (!(error instanceof Stop)) throw error
      this.#skipping = true
    }
  }

  /* The simple query protocol: run upstream as the extended protocol, so the row cap holds. */

  async #simple(text: string): Promise<void> {
    const up = this.#up!
    this.#statements.delete('')
    this.#portals.delete('')
    let statements: Parsed[]
    try {
      statements = parseStatements(text)
    } catch (error) {
      this.#write(backend.error(syntax(error)))
      return this.#sync()
    }
    if (!statements.length) {
      this.#write(backend.emptyQuery())
      return this.#sync()
    }
    try {
      for (const { stmt, text: sent } of statements) {
        const prepared = this.#prepare(stmt, sent)
        up.parse('', prepared.text, [])
        up.bind('', '', [])
        up.describe('P', '')
        up.flush()
        await this.#expect('parseComplete', prepared.scope, prepared)
        await this.#expect('bindComplete', prepared.scope, prepared)
        const portal: Portal = { prepared, scope: prepared.scope, returned: 0, capped: false }
        const description = await this.#expect(['rowDescription', 'noData'], prepared.scope, prepared)
        if (description.name === 'rowDescription') {
          this.#describePortal(portal, description)
          this.#write(backend.rowDescription(portal.columns!))
        }
        await this.#run(portal, '', 0, true)
      }
    } catch (error) {
      if (!(error instanceof Stop)) throw error
    }
    return this.#sync()
  }

  /* The extended query protocol, message by message. */

  async #parse(name: string, text: string, types: number[]): Promise<void> {
    let statements: Parsed[]
    try {
      statements = parseStatements(text)
    } catch (error) {
      return this.#refuse(syntax(error))
    }
    if (statements.length > 1) return this.#refuse({ code: '42601', message: 'cannot insert multiple commands into a prepared statement' })
    const prepared = statements[0] ? this.#prepare(statements[0].stmt, text) : { sent: text, text, analysis: EMPTY, scope: this.#ctx.faker.request(text) }
    this.#up!.parse(name, prepared.text, types)
    this.#up!.flush()
    await this.#expect('parseComplete', prepared.scope, prepared)
    this.#statements.set(name, prepared)
    this.#write(backend.parseComplete())
  }

  async #bind(message: Extract<FrontendMessage, { type: 'bind' }>): Promise<void> {
    const prepared = this.#statements.get(message.statement)
    if (!prepared) return this.#refuse({ code: '26000', message: `prepared statement "${message.statement}" does not exist` })
    if (message.results.some((f) => f !== 0)) {
      return this.#refuse({
        code: '0A000',
        message: 'Sosie returns results in text format only. Set your driver to text results.',
      })
    }
    const format = (i: number) => (message.formats.length === 1 ? message.formats[0] : (message.formats[i] ?? 0))
    const texts = message.params.map((p, i) => (p && format(i) === 0 ? p.toString('utf8') : null))
    const scope = this.#ctx.faker.request([prepared.sent, ...texts.filter((t) => t !== null)].join('\n'), prepared.scope)
    const values = message.params.map((p, i) => {
      const text = texts[i]
      if (p === null || text === null || text === undefined) return p
      return prepared.analysis.catalogOnly ? text : rewriteParam(text, prepared.analysis.params.get(i + 1), scope)
    })
    this.#up!.bind(message.portal, message.statement, values)
    this.#up!.flush()
    await this.#expect('bindComplete', scope, prepared)
    this.#portals.set(message.portal, { prepared, scope, returned: 0, capped: false })
    this.#write(backend.bindComplete())
  }

  async #describe(kind: 'S' | 'P', name: string): Promise<void> {
    if (kind === 'S') {
      const prepared = this.#statements.get(name)
      if (!prepared) return this.#refuse({ code: '26000', message: `prepared statement "${name}" does not exist` })
      this.#up!.describe('S', name)
      this.#up!.flush()
      const parameters = await this.#expect('parameterDescription', prepared.scope, prepared)
      this.#write(backend.parameterDescription(parameters.dataTypeIDs as number[]))
      const rows = await this.#expect(['rowDescription', 'noData'], prepared.scope, prepared)
      this.#write(rows.name === 'noData' ? backend.noData() : backend.rowDescription(columns(rows)))
      return
    }
    const portal = this.#portals.get(name)
    if (!portal) return this.#refuse({ code: '34000', message: `portal "${name}" does not exist` })
    this.#up!.describe('P', name)
    this.#up!.flush()
    const rows = await this.#expect(['rowDescription', 'noData'], portal.scope, portal.prepared)
    if (rows.name === 'noData') {
      portal.columns = []
      return this.#write(backend.noData())
    }
    this.#describePortal(portal, rows)
    this.#write(backend.rowDescription(portal.columns!))
  }

  async #execute(name: string, maxRows: number): Promise<void> {
    const portal = this.#portals.get(name)
    if (!portal) return this.#refuse({ code: '34000', message: `portal "${name}" does not exist` })
    if (!portal.columns) {
      // The client did not ask for the columns; Sosie needs them to fake the rows.
      this.#up!.describe('P', name)
      this.#up!.flush()
      const rows = await this.#expect(['rowDescription', 'noData'], portal.scope, portal.prepared)
      if (rows.name === 'rowDescription') this.#describePortal(portal, rows)
      else portal.columns = []
    }
    await this.#run(portal, name, maxRows, false)
  }

  async #close(kind: 'S' | 'P', name: string): Promise<void> {
    this.#up!.close(kind, name)
    this.#up!.flush()
    await this.#expect('closeComplete', this.#ctx.faker.request(), undefined)
    if (kind === 'S') this.#statements.delete(name)
    else this.#portals.delete(name)
    this.#write(backend.closeComplete())
  }

  async #sync(): Promise<void> {
    this.#skipping = false
    if (this.#refused && !this.#failed) {
      // Postgres aborts a transaction at an error; Sosie's refusal must too, or a COMMIT would keep what came before it.
      // A named statement that fails at Parse does it, and leaves nothing behind: not even the client's unnamed one is touched.
      this.#up!.parse('sosie_refused', 'SELECT pg_catalog.sosie_refused_a_statement()', [])
      this.#up!.flush()
      while ((await this.#up!.next()).name !== 'error');
    }
    this.#refused = this.#failed = false
    this.#up!.sync()
    const ready = await this.#expect('readyForQuery', this.#ctx.faker.request(), undefined)
    this.#write(backend.readyForQuery(ready.status as string))
  }

  /* Shared steps. */

  /** Check a statement and turn the fakes in it back into real values. */
  #prepare(stmt: Parsed['stmt'], sent: string): Prepared {
    const analysis = analyze(stmt, this.#ctx.catalog, { statementTimeout: this.#ctx.statementTimeout })
    if (analysis.refusal) this.#refuse(analysis.refusal)
    const scope = this.#ctx.faker.request(sent)
    const changed = !analysis.catalogOnly && rewriteConsts(analysis, scope)
    return { sent, text: changed ? print(stmt) : sent, analysis, scope }
  }

  #describePortal(portal: Portal, message: UpstreamMessage): void {
    portal.columns = columns(message)
    portal.plans = planColumns(portal.columns, portal.prepared.analysis, this.#ctx.catalog)
  }

  /** Execute a portal upstream and relay its rows, faked, up to the row cap. */
  async #run(portal: Portal, name: string, maxRows: number, simple: boolean): Promise<void> {
    const command = portal.prepared.analysis.command
    if (portal.capped) return this.#write(backend.commandComplete(`${command} 0`))
    const allowed = this.#ctx.maxRows - portal.returned
    const want = maxRows > 0 && maxRows <= allowed ? maxRows : allowed + 1
    this.#up!.execute(name, want)
    this.#up!.flush()
    let count = 0
    for (;;) {
      const message = await this.#expect(
        ['dataRow', 'commandComplete', 'portalSuspended', 'emptyQuery'],
        portal.scope,
        portal.prepared,
        !portal.prepared.analysis.catalogOnly,
      )
      if (message.name === 'dataRow') {
        if (count++ < allowed) this.#write(backend.dataRow(fakeRow(message.fields as (string | null)[], portal.plans ?? [], this.#ctx.faker, portal.prepared.sent)))
        continue
      }
      portal.returned += Math.min(count, allowed)
      if (count > allowed) {
        portal.capped = true
        this.#write(
          backend.notice({
            severity: 'NOTICE',
            code: '01000',
            message: `Sosie returned the first ${this.#ctx.maxRows} rows; the rest were cut. Narrow the query, or start Sosie with a higher --max-rows.`,
          }),
        )
        return this.#write(backend.commandComplete(`${command} ${allowed}`))
      }
      if (message.name === 'commandComplete') return this.#write(backend.commandComplete(message.text as string))
      if (message.name === 'emptyQuery') return this.#write(backend.emptyQuery())
      return this.#write(simple ? backend.commandComplete(`${command} ${count}`) : backend.portalSuspended())
    }
  }

  /**
   * The next message upstream sends, which must be one of `names`. Notices and
   * setting changes are relayed on the way; an error is scrubbed, relayed,
   * and stops the request. `reading`: a statement that reads rows is running.
   */
  async #expect(
    names: string | string[],
    scope: RequestScope,
    prepared: Prepared | undefined,
    reading = false,
  ): Promise<UpstreamMessage> {
    const wanted = typeof names === 'string' ? [names] : names
    for (;;) {
      const message = await this.#up!.next()
      if (wanted.includes(message.name)) return message
      switch (message.name) {
        case 'notice':
          this.#write(backend.notice(this.#scrubbed(message, scope, prepared, reading)))
          continue
        case 'parameterStatus':
          if (message.parameterName !== 'session_authorization') {
            this.#write(backend.parameterStatus(message.parameterName as string, message.parameterValue as string))
          }
          continue
        case 'notification':
          continue
        case 'error':
          this.#failed = true
          this.#write(backend.error(this.#scrubbed(message, scope, prepared, reading)))
          if (message.severity === 'FATAL' || message.severity === 'PANIC') throw new Error(String(message.message))
          throw new Stop()
        default:
          throw new Error(`Unexpected ${message.name} from upstream while waiting for ${wanted.join(' or ')}`)
      }
    }
  }

  /**
   * An upstream error or notice for the client, its detail dropped. While
   * Postgres prepares a statement it has read no row, so its message holds
   * only what the client wrote and the schema, and is scrubbed of what Sosie
   * substituted. While a statement that reads rows runs, a message can quote
   * a row value in any form ('operator does not exist: Vantaville'), so only
   * its code and what the code means come back. So it is with a function's
   * message (RAISE in PL/pgSQL, anything with a context).
   */
  #scrubbed(message: UpstreamMessage, scope: RequestScope, prepared: Prepared | undefined, reading = false): Report {
    const severity = String(message.severity ?? 'ERROR')
    const code = String(message.code ?? 'XX000')
    if (message.where || code.startsWith('P0')) {
      const what = message.name === 'notice' ? 'sent a notice' : 'raised an error'
      return { severity, code, message: `A function in the database ${what}; Sosie hides its text, which may quote rows.` }
    }
    if (reading && !VALUELESS.has(code)) {
      return { severity, code, message: `${condition(code)}: Sosie hides the rest of this message, which may quote a value from your rows.` }
    }
    const unchanged = !prepared || prepared.text === prepared.sent
    return {
      severity,
      code,
      message: scope.scrub(String(message.message ?? '')),
      hint: message.hint ? scope.scrub(String(message.hint)) : undefined,
      position: unchanged && message.position ? String(message.position) : undefined,
    }
  }

  /** Sosie's own error: relayed, and the request stops until Sync. */
  #refuse(report: Pick<Report, 'code' | 'message'>): never {
    this.#refused = true
    this.#write(backend.error({ severity: 'ERROR', ...report }))
    throw new Stop()
  }

  #write(buffer: Buffer): void {
    this.#socket.write(buffer)
  }
}

/** Errors whose messages never quote a value: their text comes back while rows are read. */
const VALUELESS = new Set(['57014', '57P01', '57P02', '57P03', '25001', '25006', '25P02', '22012', '53100', '53200', '53300', '54001', '40001', '40P01'])

/** What an SQLSTATE means, from Postgres's table of error codes. */
const CONDITIONS: Record<string, string> = {
  '22000': 'data exception',
  '22001': 'string data right truncation',
  '22003': 'numeric value out of range',
  '22004': 'null value not allowed',
  '22007': 'invalid datetime format',
  '22008': 'datetime field overflow',
  '22021': 'character not in repertoire',
  '22023': 'invalid parameter value',
  '22025': 'invalid escape sequence',
  '2201B': 'invalid regular expression',
  '2202E': 'array subscript error',
  '22P02': 'invalid text representation',
  '22P05': 'untranslatable character',
  '22032': 'invalid json text',
  '0A000': 'feature not supported',
  '42804': 'datatype mismatch',
  '42846': 'cannot coerce',
  '42883': 'undefined function',
  '42704': 'undefined object',
  '42P01': 'undefined table',
}
const CLASSES: Record<string, string> = {
  '22': 'data exception',
  '42': 'syntax error or access rule violation',
  '0A': 'feature not supported',
  '23': 'integrity constraint violation',
  '54': 'program limit exceeded',
  XX: 'internal error',
}

function condition(code: string): string {
  return `${CONDITIONS[code] ?? CLASSES[code.slice(0, 2)] ?? 'error'} (${code})`
}

function columns(message: UpstreamMessage): ColumnDescription[] {
  return (message.fields as ColumnDescription[]).map((f) => ({
    name: f.name,
    tableID: f.tableID,
    columnID: f.columnID,
    dataTypeID: f.dataTypeID,
    dataTypeSize: f.dataTypeSize,
    dataTypeModifier: f.dataTypeModifier,
  }))
}

function syntax(error: unknown): Report {
  const details = (error as { sqlDetails?: { cursorPosition?: number } }).sqlDetails
  return {
    severity: 'ERROR',
    code: '42601',
    message: (error as Error).message,
    position: details?.cursorPosition !== undefined ? String(details.cursorPosition + 1) : undefined,
  }
}
