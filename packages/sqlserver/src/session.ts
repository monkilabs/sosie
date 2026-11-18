import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { SecureContext } from 'node:tls'
import type { Faker } from '@sosie/core'
import type { Sent } from './errors.js'
import { analyze, CATALOG_PROCEDURES, parseBatch, type Analysis, type Refusal } from './guard.js'
import { ENCRYPT, FEATURE, INTEGRATED_SECURITY, OPTION, prelogin, readLogin7, readPrelogin, TDS, tdsRank, versionBytes, type Prelogin } from './login.js'
import { rewriteReply, SERVER_NAME, type Request } from './results.js'
import { constSubstitutions, substitute } from './rewrite.js'
import { PARAM, PROC, procOf, readDeclarations, readRpc, textParam, widen, widerFor, withText, writeRpc, type Call, type Param } from './rpc.js'
import type { Catalog } from './schema.js'
import { headersEnd, HEADER, INITIAL_PACKET_SIZE, Messages, MessageTooLarge, PACKET, packets, STATUS, TruncatedError, type Message } from './tds.js'
import { acceptTls } from './tls.js'
import { DONE, done, ENV, envBytes, envText, loginAck, message, readTokens, TOKEN, type Column } from './tokens.js'
import { bytesOf, textOf, UnknownTypeError, type TypeInfo } from './types.js'
import { Upstream, UpstreamError, type Target } from './upstream.js'

export interface SessionContext {
  target: Target
  catalog: Catalog
  faker: Faker
  maxRows: number
  statementTimeout: number
  /** The endpoint's certificate, as a TLS context: for TDS 8 (strict), or for TDS 7.4's TLS inside its packets. */
  secureContext: (strict: boolean) => SecureContext
  /** The upstream's version, which PRELOGIN gives clients before their session upstream opens. */
  version: string
  /** A line for the terminal running Sosie, which may name the real host. */
  log: (line: string) => void
}

/** A statement prepared through Sosie (sp_prepare, sp_prepexec), by its handle: checked once, its parameters turned back at each sp_execute. */
interface Prepared {
  analysis: Analysis
  /** The statement as Sosie sent it, and its declaration, for an execution that must widen a parameter. */
  statement: string
  declarations: string
  /**
   * The statement as the client wrote it, where Sosie turned fakes back in it, and the scope that did: each execution's
   * messages are scrubbed as the prepare's would be, the real values in the statement turned back into fakes.
   */
  text: string
  edits: Sent['edits']
  scope: Sent['scope']
}

const NO_ANALYSIS: Analysis = { catalogOnly: true, consts: [], params: new Map() }

/** An attention's acknowledgment: a DONE, never a DONEPROC, as drivers read it in a message of its own. */
const ACKNOWLEDGED = done(DONE.ATTN)

const UNREACHABLE = 'Sosie cannot reach its upstream database. The terminal running Sosie says why.'
const SQL_LOGIN_ONLY = 'Sosie takes a SQL Server login, any user and password: it does not log in with Windows, Kerberos or Microsoft Entra.'
const NO_CURSORS = 'Sosie opens no server cursors: read the rows as a forward-only, read-only result, which is every driver’s default.'

/** Requests a transaction manager request may make: begin, commit, roll back, save. No distributed transactions. */
const TRANSACTION_REQUESTS = new Set([5, 7, 8, 9])

/**
 * One client connection. Sosie answers PRELOGIN and LOGIN7 itself, taking any SQL login, then opens a session
 * upstream with its own: every request is checked, its fakes turned back into real values on the way in, and every
 * value faked on the way out.
 */
export class Session {
  #io: Duplex
  #messages: Messages | undefined
  #up: Upstream | undefined
  #packetSize = INITIAL_PACKET_SIZE
  #database = ''
  /** A request is being answered: from when it is taken until its reply is written. */
  #busy = false
  /** It is upstream: an attention goes there. */
  #inflight = false
  /** The client sent an attention for the request being answered: its acknowledgment follows the reply. */
  #attended = false
  #rpc = false
  readonly #prepared = new Map<number, Prepared>()
  #columns: Column[] = []

  constructor(
    private readonly socket: Socket,
    private readonly ctx: SessionContext,
  ) {
    this.#io = socket
  }

  async run(): Promise<void> {
    try {
      if (!(await this.#start())) return
      for (;;) {
        const message = await this.#messages!.next()
        if (!message) break
        this.#busy = true
        this.#attended = message.attended ?? false
        try {
          await this.#request(message)
        } finally {
          this.#busy = false
        }
        // The attention's answer, after the request's: drivers read one message for each they sent.
        if (this.#attended) this.#write([ACKNOWLEDGED])
        this.#attended = false
      }
    } catch (error) {
      if (error instanceof MessageTooLarge) this.#error([], 50000, `Sosie takes requests of up to 256 MB: ${error.message}`)
      else if (!(error instanceof UpstreamError)) this.ctx.log(`A client session ended: ${(error as Error).message}`)
      else this.ctx.log(`Upstream session ended: ${error.message}`)
    } finally {
      this.#up?.close()
      this.#io.end()
      this.socket.end()
    }
  }

  /* PRELOGIN, TLS and LOGIN7. */

  async #start(): Promise<boolean> {
    const head = await first(this.socket)
    let hello: Prelogin
    if (head[0] === 0x16) {
      // TDS 8: TLS before anything, then PRELOGIN inside it.
      this.#io = await acceptTls(this.socket, true, this.ctx.secureContext, head)
      this.#messages = new Messages(this.#io)
      const opening = await this.#messages.next()
      if (!opening || opening.type !== PACKET.PRELOGIN) return false
      hello = readPrelogin(opening.payload)
      this.#raw(this.#prelogin(hello, hello[OPTION.ENCRYPTION]?.[0] ?? ENCRYPT.NOT_SUP))
    } else {
      hello = readPrelogin(payloadOf(head))
      const asked = hello[OPTION.ENCRYPTION]?.[0] ?? ENCRYPT.NOT_SUP
      // A client that asks for TLS gets it; one that asks for none (Encrypt=false) gets none: the endpoint is local.
      const answer = asked === ENCRYPT.ON || asked === ENCRYPT.REQ ? ENCRYPT.ON : ENCRYPT.NOT_SUP
      this.socket.write(packets(PACKET.REPLY, this.#prelogin(hello, answer)))
      if (answer === ENCRYPT.ON) this.#io = await acceptTls(this.socket, false, this.ctx.secureContext)
      this.#messages = new Messages(this.#io)
      if (answer !== ENCRYPT.ON) this.socket.resume()
    }
    this.#messages.attention = () => this.#attention()
    const incoming = await this.#messages.next()
    if (!incoming || incoming.type !== PACKET.LOGIN7) return false
    const login = readLogin7(incoming.payload)
    this.#packetSize = Math.min(Math.max(login.packetSize || INITIAL_PACKET_SIZE, 512), 32767)
    if (login.features.has(FEATURE.FEDAUTH) || login.optionFlags2 & INTEGRATED_SECURITY || login.sspi.length) {
      this.#error([], 18456, SQL_LOGIN_ONLY, 14)
      return false
    }
    if (tdsRank(login.tdsVersion) < tdsRank(TDS.V7_2)) {
      this.#error([], 18456, 'Sosie speaks TDS 7.2 and later: the drivers of SQL Server 2005 and since.', 14)
      return false
    }
    try {
      this.#up = await Upstream.open(
        { ...this.ctx.target, database: login.database || this.ctx.target.database },
        {
          tdsVersion: login.tdsVersion,
          clientVersion: login.clientVersion,
          clientPid: login.clientPid,
          optionFlags1: login.optionFlags1,
          optionFlags2: login.optionFlags2,
          typeFlags: login.typeFlags,
          timeZone: login.timeZone,
          lcid: login.lcid,
          hostName: login.hostName,
          appName: login.appName,
          library: login.library,
          language: login.language,
          features: login.features.has(FEATURE.UTF8) ? new Map([[FEATURE.UTF8, Buffer.alloc(0)]]) : new Map(),
        },
      )
      await this.#up.batch(this.#setup())
    } catch (error) {
      if (error instanceof UpstreamError && error.tds) {
        // The upstream refused the login, or the database: by its number. Its words go to the terminal, as they may name
        // the server (Azure SQL's do) or Sosie's own login.
        this.ctx.log(`The upstream refused Sosie's login: ${error.tds.number}, ${error.tds.text}`)
        this.#error([], error.tds.number, `The upstream refused Sosie's login (message ${error.tds.number}). The terminal running Sosie says why.`, error.tds.severity)
      } else {
        this.ctx.log(`Cannot open an upstream session: ${(error as Error).message}`)
        this.#error([], 4060, UNREACHABLE, 11)
      }
      return false
    }
    const session = this.#up.session
    this.#database = session.database
    const tds = tdsRank(login.tdsVersion) >= tdsRank(TDS.V7_4) ? TDS.V7_4 : login.tdsVersion
    this.#write([
      envText(ENV.DATABASE, session.database, 'master'),
      message({ error: false, number: 5701, state: 2, severity: 0, text: `Changed database context to '${session.database}'.`, server: SERVER_NAME, proc: '', line: 1 }),
      envBytes(ENV.COLLATION, session.collation),
      envText(ENV.LANGUAGE, session.language || 'us_english'),
      message({ error: false, number: 5703, state: 1, severity: 0, text: `Changed language setting to ${session.language || 'us_english'}.`, server: SERVER_NAME, proc: '', line: 1 }),
      loginAck(tds, session.program, session.programVersion),
      ...(login.features.size ? [Buffer.from([TOKEN.FEATUREEXTACK, ...(login.features.has(FEATURE.UTF8) ? [FEATURE.UTF8, 1, 0, 0, 0, 1] : []), FEATURE.END])] : []),
      envText(ENV.PACKET_SIZE, String(this.#packetSize), String(INITIAL_PACKET_SIZE)),
      done(DONE.FINAL),
    ])
    return true
  }

  #prelogin(hello: Prelogin, encryption: number): Buffer {
    return prelogin([
      [OPTION.VERSION, versionBytes(this.ctx.version)],
      [OPTION.ENCRYPTION, Buffer.from([encryption])],
      [OPTION.INSTANCE, Buffer.from([0])],
      [OPTION.THREADID, Buffer.alloc(0)],
      [OPTION.MARS, Buffer.from([0])],
      ...(hello[OPTION.FEDAUTH] ? ([[OPTION.FEDAUTH, Buffer.from([0])]] as [number, Buffer][]) : []),
    ])
  }

  /** Sosie's settings on every session upstream: browse mode, which names each value's column, and the cap on rows. */
  #setup(): string {
    return `SET NO_BROWSETABLE ON; SET ROWCOUNT ${this.ctx.maxRows + 1};`
  }

  /* Requests. */

  /**
   * An attention, which stops the request being answered. Upstream, it goes there; before it goes, it goes with it;
   * after its reply was written, it is acknowledged at once. Its acknowledgment is a message of its own, after the
   * request's reply.
   */
  #attention(): void {
    if (!this.#busy) return this.#write([ACKNOWLEDGED])
    this.#attended = true
    if (this.#inflight) this.#up?.attention()
  }

  async #request(message: Message): Promise<void> {
    this.#rpc = message.type === PACKET.RPC
    // The client stopped sending it: nothing of it runs, and it is answered like any other.
    if (message.ignored) return this.#write([done(DONE.FINAL, 0, this.#rpc ? TOKEN.DONEPROC : TOKEN.DONE)])
    let prefix: Buffer[] = []
    try {
      if (message.status & (STATUS.RESET | STATUS.RESET_SKIP_TRAN)) {
        const reset = await this.#reset(message.status, message.payload.subarray(0, headersEnd(message.payload)))
        if (!Array.isArray(reset)) return this.#refused([], reset)
        prefix = reset
      }
      switch (message.type) {
        case PACKET.BATCH:
          return await this.#batch(message.payload, prefix)
        case PACKET.RPC:
          return await this.#rpcRequest(message.payload, prefix)
        case PACKET.TRANSACTION:
          return await this.#transaction(message.payload, prefix)
        case PACKET.BULK:
          return this.#refused(prefix, { number: 3906, message: 'A bulk load changes data. Sosie is read-only.' })
        default:
          return this.#refused(prefix, { number: 50000, message: `Sosie does not take this request (packet type 0x${message.type.toString(16)}).` })
      }
    } catch (error) {
      if (error instanceof TruncatedError || error instanceof UnknownTypeError) {
        return this.#refused(prefix, { number: 50000, message: `Sosie cannot read this request: ${error.message}` })
      }
      throw error
    }
  }

  /**
   * A session reset, as a driver's pool asks for one: done upstream with Sosie's settings again, which a reset
   * clears, in the transaction the request runs in (RESET_SKIP_TRAN keeps it open): the request's own ALL_HEADERS.
   * The client is told what the reset changed, its acknowledgment among it. Settings that fail to be set again leave
   * the session without browse mode or the cap on rows: the request is refused, not run without them.
   */
  async #reset(status: number, headers: Buffer): Promise<Buffer[] | Refusal> {
    const payload = Buffer.concat([headers, Buffer.from(this.#setup(), 'utf16le')])
    const reply = await this.#up!.request(PACKET.BATCH, payload, { status })
    this.#prepared.clear()
    const out: Buffer[] = []
    for (const t of readTokens(reply.payload)) {
      if (t.kind === 'message' && t.error) {
        this.ctx.log(`Sosie's settings failed after a session reset: ${t.number}, ${t.text}`)
        return { number: 50000, message: `Sosie could not set its settings again after the session's reset (message ${t.number}): it runs nothing without them.` }
      }
      if (t.kind !== 'envchange') continue
      if (t.type === ENV.DATABASE) this.#database = t.data.subarray(2, 2 + (t.data[1] ?? 0) * 2).toString('utf16le')
      if (t.type === ENV.RESET_ACK || t.type === ENV.DATABASE || t.type === ENV.LANGUAGE || t.type === ENV.COLLATION) out.push(t.raw)
    }
    if (!out.some((b) => b[3] === ENV.RESET_ACK)) out.unshift(Buffer.from([TOKEN.ENVCHANGE, 3, 0, ENV.RESET_ACK, 0, 0]))
    return out
  }

  async #batch(payload: Buffer, prefix: Buffer[]): Promise<void> {
    const at = headersEnd(payload)
    const text = payload.subarray(at).toString('utf16le')
    let analysis: Analysis
    try {
      analysis = analyze(parseBatch(text), text, this.ctx.catalog, this.#database, { maxRows: this.ctx.maxRows })
    } catch (error) {
      return this.#syntax(prefix, error)
    }
    if (analysis.refusal) return this.#refused(prefix, analysis.refusal)
    const scope = this.ctx.faker.request(text)
    const rewritten = analysis.catalogOnly ? undefined : substitute(text, constSubstitutions(analysis.consts, scope))
    const sent: Sent = { text, sql: rewritten?.sql ?? text, edits: rewritten?.edits ?? [], scope }
    const out = rewritten ? Buffer.concat([payload.subarray(0, at), Buffer.from(rewritten.sql, 'utf16le')]) : payload
    await this.#send(PACKET.BATCH, out, { analyses: [analysis], sent: [sent], handles: [new Set()] }, prefix)
  }

  async #rpcRequest(payload: Buffer, prefix: Buffer[]): Promise<void> {
    const rpc = readRpc(payload, headersEnd(payload))
    const request: Request = { analyses: [], sent: [], handles: [] }
    const preparing = new Map<number, Prepared>()
    for (const [i, call] of rpc.calls.entries()) {
      if (call.params.some((p) => p.status & PARAM.ENCRYPTED)) {
        return this.#refused(prefix, { number: 50000, message: 'Sosie does not read Always Encrypted parameters: their values are the client’s to decrypt.' })
      }
      const handled = this.#call(call)
      if ('refusal' in handled) return this.#refused(prefix, handled.refusal)
      if ('syntax' in handled) return this.#syntax(prefix, handled.syntax)
      rpc.calls[i] = handled.call
      request.analyses.push(handled.analysis)
      request.sent.push(handled.sent)
      request.handles.push(handled.handles)
      if (handled.prepared) preparing.set(i, handled.prepared)
    }
    const rewritten = await this.#send(PACKET.RPC, writeRpc(rpc), request, prefix)
    for (const [i, handle] of rewritten?.handles ?? []) {
      const prepared = preparing.get(i)
      if (prepared) this.#prepared.set(handle, prepared)
    }
  }

  /** One call of an RPC: checked, its fakes turned back, in the statement and in its parameters. */
  #call(call: Call):
    | { call: Call; analysis: Analysis; sent: Sent | undefined; handles: Set<number>; prepared?: Prepared }
    | { refusal: Refusal }
    | { syntax: unknown } {
    const proc = procOf(call)
    const params = [...call.params]
    switch (proc) {
      case PROC.EXECUTESQL:
        return this.#statementCall(call, params, { statement: 0, declarations: 1, values: 2 })
      case PROC.PREPEXEC:
        return this.#statementCall(call, params, { handle: 0, declarations: 1, statement: 2, values: 3 })
      case PROC.PREPARE:
        return this.#statementCall(call, params, { handle: 0, declarations: 1, statement: 2, values: params.length })
      case PROC.EXECUTE: {
        const handle = params[0]?.value.bytes?.readInt32LE()
        const prepared = handle === undefined ? undefined : this.#prepared.get(handle)
        if (!prepared) return { refusal: { number: 8179, message: `Could not find prepared statement with handle ${handle ?? '(none)'}: Sosie checks each statement it runs, so prepare it through Sosie.` } }
        const scope = this.ctx.faker.request([prepared.text, ...valueTexts(params.slice(1))].join('\n'), prepared.scope)
        const declared = readDeclarations(prepared.declarations)
        const widened = this.#turnBack(params, 1, declared, prepared.analysis, scope)
        const sent: Sent = { text: prepared.text, sql: prepared.statement, edits: prepared.edits, scope }
        if (!widened.size) return { call: { ...call, params }, analysis: prepared.analysis, sent, handles: new Set() }
        // A real value longer than the prepared parameter's type: run as sp_executesql, its declaration widened.
        const statement = withText(params[0]!, prepared.statement)
        const declarations = withText(params[0]!, widen(prepared.declarations, declared, widened))
        return {
          call: { proc: PROC.EXECUTESQL, options: call.options, params: [{ ...statement, name: '' }, { ...declarations, name: '' }, ...params.slice(1)] },
          analysis: prepared.analysis,
          sent,
          handles: new Set(),
        }
      }
      case PROC.UNPREPARE: {
        const handle = params[0]?.value.bytes?.readInt32LE()
        if (handle !== undefined) this.#prepared.delete(handle)
        return { call, analysis: NO_ANALYSIS, sent: undefined, handles: new Set() }
      }
      case PROC.PREPEXECRPC:
      case PROC.CURSOR:
      case PROC.CURSOROPEN:
      case PROC.CURSORPREPARE:
      case PROC.CURSOREXECUTE:
      case PROC.CURSORPREPEXEC:
      case PROC.CURSORUNPREPARE:
      case PROC.CURSORFETCH:
      case PROC.CURSOROPTION:
      case PROC.CURSORCLOSE:
        return { refusal: { number: 50000, message: NO_CURSORS } }
      default: {
        const name = typeof proc === 'string' ? proc : ''
        if (!CATALOG_PROCEDURES.has(name)) {
          return { refusal: { number: 50000, message: `Sosie runs no procedures but the catalog's (sp_tables, sp_columns): ${name || 'this one'} may change data, or read rows Sosie cannot see.` } }
        }
        if (params.some((p) => p.status & PARAM.BY_REF)) return { refusal: { number: 50000, message: 'Sosie does not return OUTPUT parameters.' } }
        return { call, analysis: NO_ANALYSIS, sent: undefined, handles: new Set() }
      }
    }
  }

  /** sp_executesql, sp_prepexec, sp_prepare: the statement checked and turned back, then the values compared in it. */
  #statementCall(
    call: Call,
    params: Param[],
    at: { statement: number; declarations: number; values: number; handle?: number },
  ): { call: Call; analysis: Analysis; sent: Sent; handles: Set<number>; prepared?: Prepared } | { refusal: Refusal } | { syntax: unknown } {
    const text = textParam(params[at.statement])
    if (text === undefined) return { refusal: { number: 214, message: "Procedure expects parameter '@statement' of type 'ntext/nchar/nvarchar'." } }
    const declarations = textParam(params[at.declarations]) ?? ''
    let analysis: Analysis
    try {
      analysis = analyze(parseBatch(text), text, this.ctx.catalog, this.#database, { maxRows: this.ctx.maxRows })
    } catch (error) {
      return { syntax: error }
    }
    if (analysis.refusal) return { refusal: analysis.refusal }
    const declared = readDeclarations(declarations)
    if (declared.some((d) => d.output)) return { refusal: { number: 50000, message: 'Sosie does not return OUTPUT parameters: SELECT the value instead.' } }
    const scope = this.ctx.faker.request([text, ...valueTexts(params.slice(at.values))].join('\n'))
    const rewritten = analysis.catalogOnly ? undefined : substitute(text, constSubstitutions(analysis.consts, scope))
    if (rewritten) params[at.statement] = withText(params[at.statement]!, rewritten.sql)
    const widened = this.#turnBack(params, at.values, declared, analysis, scope)
    if (widened.size && params[at.declarations]) params[at.declarations] = withText(params[at.declarations]!, widen(declarations, declared, widened))
    const sent: Sent = { text, sql: rewritten?.sql ?? text, edits: rewritten?.edits ?? [], scope }
    const handles = at.handle === undefined ? new Set<number>() : new Set([at.handle])
    const prepared = at.handle === undefined ? undefined : { analysis, statement: sent.sql, declarations: widened.size ? widen(declarations, declared, widened) : declarations, text, edits: sent.edits, scope }
    return { call: { ...call, params }, analysis, sent, handles, ...(prepared && { prepared }) }
  }

  /**
   * Each value compared with a column, from `from` on, turned back where it is a fake: in its own type, at its max
   * where the real value is longer. The names of those widened, for the declaration.
   */
  #turnBack(params: Param[], from: number, declared: ReturnType<typeof readDeclarations>, analysis: Analysis, scope: ReturnType<Faker['request']>): Map<string, TypeInfo> {
    const widened = new Map<string, TypeInfo>()
    if (analysis.catalogOnly) return widened
    for (let k = from; k < params.length; k++) {
      const p = params[k]!
      const name = (p.name || declared[k - from]?.name || '').toLowerCase()
      if (!analysis.params.has(name)) continue
      const near = analysis.params.get(name)
      if (near === 'catalog' || p.value.bytes === null) continue
      const text = textOf(p.type, p.value.bytes)
      if (text === undefined) continue
      const real = scope.lookup(text, near)
      if (real === undefined || real === text) continue
      const wider = widerFor(p.type, real)
      const type = wider ?? p.type
      if (wider) widened.set(name, wider)
      const bytes = bytesOf(type, real, wider || type.layout === 'plp' ? undefined : p.value.bytes)
      if (bytes) params[k] = { ...p, type, value: { bytes } }
    }
    return widened
  }

  async #transaction(payload: Buffer, prefix: Buffer[]): Promise<void> {
    const kind = payload.readUInt16LE(headersEnd(payload))
    if (!TRANSACTION_REQUESTS.has(kind)) return this.#refused(prefix, { number: 50000, message: 'Sosie runs no distributed transactions.' })
    await this.#send(PACKET.TRANSACTION, payload, { analyses: [NO_ANALYSIS], sent: [undefined], handles: [new Set()] }, prefix)
  }

  /** A request upstream, answered: faked, or an error if Sosie stopped it at its time limit. */
  async #send(type: number, payload: Buffer, request: Request, prefix: Buffer[]) {
    this.#inflight = true
    let reply
    try {
      reply = await this.#up!.request(type, payload, { timeout: this.ctx.statementTimeout, cancel: this.#attended })
    } finally {
      this.#inflight = false
    }
    if (reply.timedOut) {
      // Stopped, but what ran before it stands: a USE among it moved the session upstream, and so Sosie's.
      this.#database = databaseIn(reply.payload) ?? this.#database
      this.#error(prefix, 50000, `Sosie stopped the statement at its time limit, ${this.ctx.statementTimeout} ms. Narrow the query, or raise timeout in sosie.yml.`)
      return undefined
    }
    const rewritten = rewriteReply(reply.payload, request, { catalog: this.ctx.catalog, faker: this.ctx.faker, maxRows: this.ctx.maxRows, database: this.#database }, this.#columns)
    this.#columns = rewritten.columns
    if (rewritten.database !== undefined) this.#database = rewritten.database
    // Stopped before it began, the request has no reply of its own but the attention's: it gets a DONE.
    const answer = rewritten.payload.length ? rewritten.payload : done(DONE.ERROR, 0, this.#rpc ? TOKEN.DONEPROC : TOKEN.DONE)
    this.#write([...prefix, answer])
    return rewritten
  }

  #refused(prefix: Buffer[], refusal: Refusal): void {
    this.#error(prefix, refusal.number, refusal.message)
  }

  #syntax(prefix: Buffer[], error: unknown): void {
    const why = String((error as Error).message ?? error).replace(/^sql parser error: /, '')
    this.#error(prefix, 102, `Incorrect syntax, or syntax Sosie's parser does not read: ${why}`, 15)
  }

  #error(prefix: Buffer[], number: number, text: string, severity = 16): void {
    this.#write([
      ...prefix,
      message({ error: true, number, state: 1, severity, text, server: SERVER_NAME, proc: '', line: 1 }),
      done(DONE.ERROR, 0, this.#rpc ? TOKEN.DONEPROC : TOKEN.DONE),
    ])
  }

  #write(tokens: Buffer[]): void {
    this.#raw(Buffer.concat(tokens))
  }

  #raw(payload: Buffer): void {
    if (!this.#io.writable) return
    this.#io.write(packets(PACKET.REPLY, payload, this.#packetSize))
  }
}

/** The database a reply leaves the session in, where it changes it. */
function databaseIn(payload: Buffer): string | undefined {
  let database: string | undefined
  try {
    for (const t of readTokens(payload)) if (t.kind === 'envchange' && t.type === ENV.DATABASE) database = t.data.subarray(2, 2 + (t.data[1] ?? 0) * 2).toString('utf16le')
  } catch {
    // A reply cut where the server stopped: what came before the cut is what it said.
  }
  return database
}

/** The texts of parameters' values, so a scope knows what the client sent. */
function valueTexts(params: Param[]): string[] {
  return params.flatMap((p) => {
    if (p.value.bytes === null) return []
    const text = textOf(p.type, p.value.bytes)
    return text === undefined ? [] : [text]
  })
}

/** The client's first bytes: a ClientHello (TDS 8), or a whole PRELOGIN message. */
function first(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const whole = () => {
      for (let at = 0; at + HEADER <= buf.length; ) {
        const length = buf.readUInt16BE(at + 2)
        if (length < HEADER || at + length > buf.length) return false
        if (buf[at + 1]! & STATUS.EOM) return true
        at += length
      }
      return false
    }
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf[0] === 0x16 || whole() || buf.length > 64 * 1024) {
        socket.off('data', onData)
        socket.off('close', onClose)
        socket.pause()
        resolve(buf)
      }
    }
    const onClose = () => reject(new Error('closed before PRELOGIN'))
    socket.on('data', onData)
    socket.once('close', onClose)
  })
}

/** A message's payload from its packets. */
function payloadOf(buf: Buffer): Buffer {
  const parts: Buffer[] = []
  for (let at = 0; at + HEADER <= buf.length; ) {
    const length = buf.readUInt16BE(at + 2)
    parts.push(buf.subarray(at + HEADER, at + length))
    at += length
  }
  return Buffer.concat(parts)
}
