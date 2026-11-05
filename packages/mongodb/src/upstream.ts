import type { RequestScope } from '@sosie/core'
import { Long, type Document } from 'bson'
import { MongoClient, MongoServerError, type ClientSession } from 'mongodb'
import { READ } from './protocol.js'
import type { Shape } from './shape.js'

/**
 * The driver's options from the connection string, the password never in an argument; reads where the string says.
 * Its heartbeats poll, so no hello is held open on each server: Sosie learns of a failover within the heartbeat.
 */
export function connect(upstream: URL): MongoClient {
  return new MongoClient(upstream.href, { appName: 'sosie', serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, serverMonitoringMode: 'poll' })
}

/** Fields a client sends that are the session's or the cluster's, set upstream by Sosie's own driver instead. */
const SESSION_FIELDS = new Set(['lsid', 'txnNumber', 'autocommit', 'startTransaction', 'apiVersion', 'apiStrict', 'apiDeprecationErrors', 'writeConcern'])

/** A command as Sosie sends it upstream: none of the client's session, cluster or read-preference fields. */
export function cleaned(body: Document): Document {
  const out: Document = {}
  for (const [key, value] of Object.entries(body)) if (!key.startsWith('$') && !SESSION_FIELDS.has(key)) out[key] = value
  if (out.readConcern && typeof out.readConcern === 'object') {
    // A cluster time is the upstream's, which Sosie never shows the client: none can come back.
    const { afterClusterTime: _, ...rest } = out.readConcern as Document
    out.readConcern = rest
  }
  return out
}

/** Fields of an answer that are the upstream cluster's: its clock, signed, and where it is in its log. */
const CLUSTER_FIELDS = ['$clusterTime', 'operationTime', '$configTime', '$topologyTime', '$gleStats', 'lastCommittedOpTime', '$configServerState']

export function answer(doc: Document): Document {
  for (const field of CLUSTER_FIELDS) delete doc[field]
  return doc
}

export interface UpstreamError {
  code: number
  codeName: string
  errmsg: string
}

/** A cursor open upstream: whose session it is in, and how its documents are faked. */
export interface Cursor {
  db: string
  collection: string
  session: ClientSession
  shape: Shape
  scope: RequestScope | undefined
  sent: string
  /** Documents returned so far: past the cap, the cursor is closed. */
  served: number
  /** Whose it is: the client's own session (its lsid), or the connection of a client that sends none. */
  owner: object | string
}

/** How long an upstream session for a client's session is kept unused: MongoDB's own logical session timeout. */
const SESSION_IDLE = 30 * 60_000

/** The upstream: one client, and the cursors open on it, by id, for any connection to continue. */
export class Upstream {
  readonly cursors = new Map<string, Cursor>()
  /** An upstream session for each of the clients' sessions, by lsid: a driver continues a cursor from any connection. */
  readonly #sessions = new Map<string, { session: ClientSession; used: number }>()
  #swept = Date.now()

  constructor(readonly client: MongoClient) {}

  /** The upstream session for a client's session; one unused for half an hour is ended, as MongoDB ends its own. */
  sessionFor(lsid: string): ClientSession {
    const now = Date.now()
    if (now - this.#swept > 60_000) {
      this.#swept = now
      for (const [key, held] of this.#sessions) if (now - held.used > SESSION_IDLE) void this.endSession(key)
    }
    let held = this.#sessions.get(lsid)
    if (!held) this.#sessions.set(lsid, (held = { session: this.client.startSession(), used: now }))
    held.used = now
    return held.session
  }

  /** A client's session ended: its cursors closed, and the upstream session with them. */
  async endSession(lsid: string): Promise<void> {
    const held = this.#sessions.get(lsid)
    this.#sessions.delete(lsid)
    await this.killOwned(lsid).catch(() => {})
    await held?.session.endSession().catch(() => {})
  }

  /** Run a command, its answer in BSON's own types. A MongoDB error comes back as one; anything else throws. */
  async command(db: string, command: Document, session: ClientSession): Promise<Document | UpstreamError> {
    try {
      return (await this.client.db(db).command(command, { session, ...READ, readPreference: this.client.readPreference })) as Document
    } catch (error) {
      if (error instanceof MongoServerError) {
        return { code: Number(error.code ?? 1), codeName: String(error.codeName ?? 'UnknownError'), errmsg: error.errmsg ?? error.message }
      }
      throw error
    }
  }

  /** Close cursors upstream, and forget them. */
  async kill(ids: Long[]): Promise<void> {
    for (const id of ids) {
      const cursor = this.cursors.get(id.toString())
      if (!cursor) continue
      this.cursors.delete(id.toString())
      await this.command(cursor.db, { killCursors: cursor.collection, cursors: [id] }, cursor.session).catch(() => {})
    }
  }

  /** Close every cursor of an owner; without one, every cursor. */
  async killOwned(owner?: object | string): Promise<void> {
    const ids = [...this.cursors.entries()].filter(([, c]) => !owner || c.owner === owner).map(([id]) => id)
    for (const id of ids) {
      const cursor = this.cursors.get(id)!
      this.cursors.delete(id)
      await this.client
        .db(cursor.db)
        .command({ killCursors: cursor.collection, cursors: [Long.fromString(id)] }, { session: cursor.session })
        .catch(() => {})
    }
  }
}

export function isError(doc: Document | UpstreamError): doc is UpstreamError {
  return typeof (doc as UpstreamError).errmsg === 'string' && typeof (doc as UpstreamError).code === 'number' && !('ok' in doc && Number(doc.ok) === 1)
}
