import type { Socket } from 'node:net'
import type { Faker, FieldType, RequestScope } from '@sosie/core'
import { Double, EJSON, Int32, Long, UUID, type Document } from 'bson'
import type { ClientSession } from 'mongodb'
import { errorAnswer, sosieError } from './errors.js'
import { fakeDocument } from './fake.js'
import { commandName, plan } from './guard.js'
import { MessageReader, msgReply, OP, opReply, ProtocolError, type Message } from './protocol.js'
import { rewriteFilter, rewritePipeline } from './rewrite.js'
import type { Catalog } from './schema.js'
import { at, COMPUTED, pipeline, projection, type Shape } from './shape.js'
import { answer, cleaned, isError, type Upstream, type UpstreamError } from './upstream.js'

export interface SessionContext {
  upstream: Upstream
  catalog: Catalog
  faker: Faker
  maxRows: number
  statementTimeout: number
  /** The upstream's version and wire versions, which Sosie's hello gives as its own. */
  server: { version: string; minWireVersion: number; maxWireVersion: number }
  /** Told the schema has grown: a field was met for the first time. */
  learned: () => void
  /** A line for the terminal running Sosie, which may name the real host. */
  log: (line: string) => void
}

const LITERAL: Shape = { kind: 'literal' }
const UNREACHABLE = 'Sosie cannot reach its upstream database. The terminal running Sosie says why.'
const NO_LOGIN = 'Sosie takes no login: connect without a user and password.'

let connections = 0

/** A client session's id, as text: its lsid's UUID. */
function sessionKey(lsid: unknown): string | undefined {
  const id = (lsid as { id?: { buffer?: Uint8Array; position?: number } } | undefined)?.id
  return id?.buffer ? Buffer.from(id.buffer.subarray(0, id.position ?? id.buffer.length)).toString('hex') : undefined
}

/**
 * One client connection. Sosie answers the handshake itself, as a standalone server that takes any client without a
 * login, then runs each read upstream in a session of its own: checked, its fakes turned back into real values on
 * the way in, and every value faked on the way out.
 */
export class Session {
  readonly #reader: MessageReader
  readonly #id = ++connections
  #session: ClientSession | undefined
  /** The command being answered: a connection answers one at a time. */
  #current: Document = {}

  constructor(
    private readonly socket: Socket,
    private readonly ctx: SessionContext,
  ) {
    this.#reader = new MessageReader(socket)
  }

  async run(): Promise<void> {
    try {
      for (;;) {
        const message = await this.#reader.next()
        if (!message) break
        const reply = await this.#handle(message)
        if (reply && !message.moreToCome) this.socket.write(reply)
      }
    } catch (error) {
      if (!(error instanceof ProtocolError)) this.ctx.log(`Upstream session ended: ${(error as Error).message}`)
    } finally {
      await this.ctx.upstream.killOwned(this).catch(() => {})
      await this.#session?.endSession().catch(() => {})
      this.socket.end()
    }
  }

  async #handle(message: Message): Promise<Buffer | undefined> {
    if (message.opCode === OP.QUERY) {
      // Only the first hello of a handshake comes as OP_QUERY, its command maybe under $query.
      const query = (message.body.$query as Document | undefined) ?? message.body
      const name = commandName(query)
      const doc = name === 'hello' || name === 'isMaster' || name === 'ismaster' ? this.#hello(name) : sosieError(59, 'CommandNotFound', 'Sosie answers OP_QUERY only for hello: use OP_MSG.')
      return opReply(message.requestId, doc)
    }
    if (message.opCode !== OP.MSG) {
      return msgReply(message.requestId, sosieError(2, 'BadValue', message.opCode === OP.COMPRESSED ? 'Sosie offers no compression.' : `Sosie does not read opCode ${message.opCode}.`))
    }
    return msgReply(message.requestId, await this.#command(message.body))
  }

  async #command(body: Document): Promise<Document> {
    this.#current = body
    if (commandName(body) === 'endSessions') {
      for (const lsid of Array.isArray(body.endSessions) ? body.endSessions : []) {
        const key = sessionKey(lsid)
        if (key) await this.ctx.upstream.endSession(key)
      }
      return { ok: new Double(1) }
    }
    const decided = plan(body)
    if (decided.kind === 'refused') return { ok: 0, ...decided.refusal }
    if (decided.kind === 'local') return this.#local(body)
    try {
      switch (decided.command) {
        case 'find':
          return await this.#find(body)
        case 'aggregate':
          return await this.#aggregate(body)
        case 'count':
          return await this.#count(body)
        case 'distinct':
          return await this.#distinct(body)
        case 'getMore':
          return await this.#getMore(body)
        case 'killCursors':
          return await this.#killCursors(body)
        default:
          return await this.#schema(body)
      }
    } catch (error) {
      this.ctx.log(`Upstream: ${(error as Error).message}`)
      return sosieError(6, 'HostUnreachable', UNREACHABLE)
    }
  }

  /* What Sosie answers itself. */

  #hello(name: string): Document {
    return {
      ...(name === 'hello' ? { isWritablePrimary: true } : { ismaster: true }),
      helloOk: true,
      maxBsonObjectSize: new Int32(16 * 1024 * 1024),
      maxMessageSizeBytes: new Int32(48_000_000),
      maxWriteBatchSize: new Int32(100_000),
      localTime: new Date(),
      logicalSessionTimeoutMinutes: new Int32(30),
      connectionId: new Int32(this.#id),
      minWireVersion: new Int32(this.ctx.server.minWireVersion),
      maxWireVersion: new Int32(this.ctx.server.maxWireVersion),
      readOnly: false,
      ok: new Double(1),
    }
  }

  #local(body: Document): Document {
    const name = commandName(body)!
    const ok = { ok: new Double(1) }
    switch (name) {
      case 'hello':
      case 'isMaster':
      case 'ismaster':
        return this.#hello(name)
      case 'ping':
      case 'refreshSessions':
      case 'logout':
        return ok
      case 'buildInfo':
      case 'buildinfo': {
        const version = this.ctx.server.version
        const parts = version.split('.').map((p) => new Int32(Number.parseInt(p, 10) || 0))
        while (parts.length < 4) parts.push(new Int32(0))
        return { version, versionArray: parts, bits: new Int32(64), maxBsonObjectSize: new Int32(16 * 1024 * 1024), javascriptEngine: 'none', ...ok }
      }
      case 'startSession':
        return { id: { id: new UUID() }, timeoutMinutes: new Int32(30), ...ok }
      case 'whatsmyuri':
        return { you: `${this.socket.remoteAddress}:${this.socket.remotePort}`, ...ok }
      case 'connectionStatus':
        return { authInfo: { authenticatedUsers: [], authenticatedUserRoles: [] }, ...ok }
      case 'getLog':
        return { totalLinesWritten: new Int32(0), log: [], ...ok }
      case 'getParameter':
        if (body.featureCompatibilityVersion && Object.keys(body).filter((k) => !k.startsWith('$') && k !== 'getParameter').length === 1) {
          return { featureCompatibilityVersion: { version: this.ctx.server.version.split('.').slice(0, 2).join('.') }, ...ok }
        }
        return sosieError(13, 'Unauthorized', 'Sosie does not show the server’s settings.')
      case 'saslStart':
      case 'saslContinue':
      case 'authenticate':
        return sosieError(18, 'AuthenticationFailed', NO_LOGIN)
      case 'hostInfo':
      case 'getCmdLineOpts':
      case 'serverStatus':
        return sosieError(13, 'Unauthorized', `Sosie does not run ${name}: it shows where the server is.`)
      default:
        return sosieError(59, 'CommandNotFound', `no such command: '${name}'`)
    }
  }

  /* Reads. */

  /** Whose a cursor opened now is: the client's session, or this connection when it sends none. */
  get #owner(): object | string {
    return sessionKey(this.#current.lsid) ?? this
  }

  /** The upstream session the command runs in: its client session's, or this connection's own. */
  get #upstreamSession(): ClientSession {
    const key = sessionKey(this.#current.lsid)
    return key ? this.ctx.upstream.sessionFor(key) : (this.#session ??= this.ctx.upstream.client.startSession())
  }

  /** A command as it goes upstream: cleaned, and held to Sosie's time limit. */
  #upstreamCommand(body: Document, change: Document = {}): Document {
    const command = { ...cleaned(body), ...change }
    const asked = Number(body.maxTimeMS ?? 0)
    command.maxTimeMS = new Int32(asked > 0 ? Math.min(asked, this.ctx.statementTimeout) : this.ctx.statementTimeout)
    return command
  }

  #scope(body: Document): { scope: RequestScope; sent: string } {
    const sent = EJSON.stringify(cleaned(body), { relaxed: true })
    return { scope: this.ctx.faker.request(sent), sent }
  }

  async #run(db: string, command: Document): Promise<Document | UpstreamError> {
    return this.ctx.upstream.command(db, command, this.#upstreamSession)
  }

  async #find(body: Document): Promise<Document> {
    const db = String(body.$db)
    const name = String(body.find)
    const start = this.ctx.catalog.start(db, name)
    const { scope, sent } = this.#scope(body)
    const filter = body.filter === undefined ? {} : { filter: rewriteFilter(body.filter, start, scope) }
    const result = await this.#run(db, this.#upstreamCommand(body, filter))
    if (isError(result)) return errorAnswer(result, scope)
    return this.#cursor(result, { db, collection: name, shape: projection(body.projection as Document | undefined, start), scope, sent })
  }

  async #aggregate(body: Document): Promise<Document> {
    if (body.explain) return sosieError(13, 'Unauthorized', 'Sosie does not run explain: a plan shows the real values Sosie puts in your query.')
    const db = String(body.$db)
    const name = typeof body.aggregate === 'string' ? body.aggregate : undefined
    const start = name ? this.ctx.catalog.start(db, name) : LITERAL
    const entityOf = (other: string) => this.ctx.catalog.entityOf(db, other)
    const { scope, sent } = this.#scope(body)
    const stages = body.pipeline as Document[]
    const result = await this.#run(db, this.#upstreamCommand(body, { pipeline: rewritePipeline(stages, start, scope, entityOf) }))
    if (isError(result)) return errorAnswer(result, scope)
    return this.#cursor(result, { db, collection: name ?? '$cmd.aggregate', shape: pipeline(stages, start, entityOf), scope, sent })
  }

  async #count(body: Document): Promise<Document> {
    const db = String(body.$db)
    const start = this.ctx.catalog.start(db, String(body.count))
    const { scope } = this.#scope(body)
    const query = body.query === undefined ? {} : { query: rewriteFilter(body.query, start, scope) }
    const result = await this.#run(db, this.#upstreamCommand(body, query))
    // A count is a number of documents, not a value of one.
    return isError(result) ? errorAnswer(result, scope) : answer(result)
  }

  async #distinct(body: Document): Promise<Document> {
    const db = String(body.$db)
    const start = this.ctx.catalog.start(db, String(body.distinct))
    const { scope, sent } = this.#scope(body)
    const query = body.query === undefined ? {} : { query: rewriteFilter(body.query, start, scope) }
    const result = await this.#run(db, this.#upstreamCommand(body, query))
    if (isError(result)) return errorAnswer(result, scope)
    const values = fakeDocument({ values: result.values }, { kind: 'doc', fields: new Map([['values', at(start, String(body.key))]]), rest: COMPUTED }, this.#fakeContext(scope, sent))
    return answer({ ...result, values: values.values })
  }

  async #getMore(body: Document): Promise<Document> {
    const id = body.getMore as Long
    const cursor = this.#owned(String(id))
    if (!cursor) return sosieError(43, 'CursorNotFound', `cursor id ${String(id)} not found`)
    const command = cleaned(body)
    // A time limit on getMore is for a tailable cursor only; the find's holds for the rest.
    const result = await this.ctx.upstream.command(cursor.db, command, cursor.session)
    if (isError(result)) {
      this.ctx.upstream.cursors.delete(String(id))
      return errorAnswer(result, cursor.scope)
    }
    return this.#batch(result, String(id), cursor, 'nextBatch')
  }

  async #killCursors(body: Document): Promise<Document> {
    const ids = (Array.isArray(body.cursors) ? body.cursors : []) as Long[]
    const known = ids.filter((id) => this.#owned(String(id)))
    await this.ctx.upstream.kill(known)
    return { cursorsKilled: known, cursorsNotFound: ids.filter((id) => !known.includes(id)), cursorsAlive: [], cursorsUnknown: [], ok: new Double(1) }
  }

  /**
   * A cursor of the client's session, as MongoDB ties a cursor to the session that opened it: a driver may continue it
   * on any connection of its pool, and another client neither reads its batches nor closes it.
   */
  #owned(id: string) {
    const cursor = this.ctx.upstream.cursors.get(id)
    return cursor?.owner === this.#owner ? cursor : undefined
  }

  /** listCollections, listIndexes, listDatabases, dbStats: the schema and sizes, as they are. */
  async #schema(body: Document): Promise<Document> {
    const db = String(body.$db)
    const result = await this.#run(db, cleaned(body))
    if (isError(result)) return errorAnswer(result, undefined)
    const name = commandName(body)!
    if (result.cursor) return this.#cursor(result, { db, collection: name === 'listIndexes' ? String(body.listIndexes) : '$cmd.listCollections', shape: LITERAL, scope: undefined, sent: '' })
    return answer(result)
  }

  /* Cursors. */

  #cursor(result: Document, opened: { db: string; collection: string; shape: Shape; scope: RequestScope | undefined; sent: string }): Promise<Document> {
    const cursor = { ...opened, session: this.#upstreamSession, served: 0, owner: this.#owner }
    const id = String((result.cursor as Document).id)
    if (id !== '0') this.ctx.upstream.cursors.set(id, cursor)
    return this.#batch(result, id, cursor, 'firstBatch')
  }

  /** A batch of documents, each faked; past the cap on rows, the rest cut and the cursor closed. */
  async #batch(result: Document, id: string, cursor: { db: string; collection: string; shape: Shape; scope: RequestScope | undefined; sent: string; served: number; session: ClientSession }, key: 'firstBatch' | 'nextBatch'): Promise<Document> {
    const reply = answer({ ...result, cursor: { ...(result.cursor as Document) } })
    const batch = ((reply.cursor as Document)[key] ?? []) as Document[]
    const room = Math.max(0, this.ctx.maxRows - cursor.served)
    const kept = batch.slice(0, room)
    const ctx = this.#fakeContext(cursor.scope, cursor.sent)
    const out: Document[] = []
    for (const [i, doc] of kept.entries()) {
      out.push(fakeDocument(doc, cursor.shape, ctx))
      // Let other clients in now and then while a large batch is faked.
      if (i % 200 === 199) await new Promise((resolve) => setImmediate(resolve))
    }
    cursor.served += kept.length
    ;(reply.cursor as Document)[key] = out
    const exhausted = String((reply.cursor as Document).id) === '0'
    // Cut here, or with more to come upstream: the cap ends it, and the terminal says so, as MongoDB has no warning to.
    const cut = kept.length < batch.length || (!exhausted && cursor.served >= this.ctx.maxRows)
    if (exhausted) this.ctx.upstream.cursors.delete(id)
    else if (cursor.served >= this.ctx.maxRows) {
      await this.ctx.upstream.kill([Long.fromString(id)])
      ;(reply.cursor as Document).id = Long.fromNumber(0)
    }
    if (cut) this.ctx.log(`A cursor on ${cursor.collection} was cut at max-rows (${this.ctx.maxRows}).`)
    return reply
  }

  #fakeContext(scope: RequestScope | undefined, sent: string) {
    return {
      faker: this.ctx.faker,
      scope,
      sent,
      met: (entity: string, path: string, type: FieldType) => {
        if (this.ctx.catalog.meet(entity, path, type)) this.ctx.learned()
      },
    }
  }
}
