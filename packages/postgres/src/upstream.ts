import { connect } from 'node:net'
import pg from 'pg'

/** A message from the upstream server, as pg's protocol parser reads it. */
export interface UpstreamMessage {
  name: string
  [key: string]: unknown
}

/** pg's internal connection: the protocol writer this file drives. */
interface PgConnection {
  parse(query: { name: string; text: string; types: number[] }): void
  bind(config: { portal: string; statement: string; values: (string | Buffer | null)[]; binary: boolean }): void
  describe(message: { type: 'S' | 'P'; name: string }): void
  execute(config: { portal: string; rows: number }): void
  close(message: { type: 'S' | 'P'; name: string }): void
  sync(): void
  flush(): void
  on(event: string, listener: (...args: never[]) => void): void
  removeAllListeners(event: string): void
}

/** Messages pg's Client handles itself; the relay takes them over once connected. */
const CLIENT_EVENTS = [
  'rowDescription',
  'dataRow',
  'portalSuspended',
  'emptyQuery',
  'commandComplete',
  'parseComplete',
  'copyInResponse',
  'copyData',
  'notification',
  'readyForQuery',
  'errorMessage',
  'notice',
]

export interface UpstreamOptions {
  statementTimeout: number
}

/**
 * A read-only session: set at start-up, where a statement cannot undo it
 * without the guard seeing. Settings in the connection string's own
 * `options` are kept, before Sosie's, so Sosie's win.
 */
function config(upstream: URL, { statementTimeout }: UpstreamOptions): pg.ClientConfig {
  const url = new URL(upstream.href)
  const own = url.searchParams.get('options') ?? ''
  url.searchParams.delete('options')
  const settings = [
    own,
    '-c default_transaction_read_only=on',
    `-c statement_timeout=${statementTimeout}`,
    '-c DateStyle=ISO,MDY',
    '-c IntervalStyle=postgres',
    '-c bytea_output=hex',
  ]
  return {
    connectionString: url.href,
    options: settings.join(' ').trim(),
    application_name: 'sosie',
    connectionTimeoutMillis: 10_000,
  }
}

/**
 * One read-only session upstream, per client. pg's Client connects it (TLS,
 * passwords, SCRAM); after that, Sosie speaks the protocol on it message by
 * message, so it can relay the extended protocol as the client drives it.
 */
export class Upstream {
  readonly #client: pg.Client
  readonly #con: PgConnection
  readonly #queue: UpstreamMessage[] = []
  #waiting: { resolve: (m: UpstreamMessage) => void; reject: (e: Error) => void } | undefined
  #failure: Error | undefined

  private constructor(client: pg.Client, readonly parameters: Map<string, string>) {
    this.#client = client
    this.#con = (client as unknown as { connection: PgConnection }).connection
    for (const event of CLIENT_EVENTS) this.#con.removeAllListeners(event)
    this.#con.on('message', (message: UpstreamMessage) => this.#push(message))
    client.on('error', (error) => this.#fail(error))
    client.on('end', () => this.#fail(new Error('The upstream database closed the connection.')))
  }

  static async open(upstream: URL, options: UpstreamOptions): Promise<Upstream> {
    const client = new pg.Client(config(upstream, options))
    const parameters = new Map<string, string>()
    ;(client as unknown as { connection: PgConnection }).connection.on(
      'parameterStatus',
      (m: { parameterName: string; parameterValue: string }) => parameters.set(m.parameterName, m.parameterValue),
    )
    client.on('error', () => {})
    await client.connect()
    return new Upstream(client, parameters)
  }

  /** Run a plain query with pg's own machinery: only before the relay starts, for schema reading. */
  static async query<T>(upstream: URL, options: UpstreamOptions, work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client(config(upstream, options))
    client.on('error', () => {})
    await client.connect()
    try {
      return await work(client)
    } finally {
      await client.end().catch(() => {})
    }
  }

  get processID(): number {
    return (this.#client as unknown as { processID: number }).processID
  }

  get secretKey(): number {
    return (this.#client as unknown as { secretKey: number }).secretKey
  }

  parse(name: string, text: string, types: number[]): void {
    this.#con.parse({ name, text, types })
  }

  bind(portal: string, statement: string, values: (string | Buffer | null)[]): void {
    this.#con.bind({ portal, statement, values, binary: false })
  }

  describe(type: 'S' | 'P', name: string): void {
    this.#con.describe({ type, name })
  }

  execute(portal: string, rows: number): void {
    this.#con.execute({ portal, rows })
  }

  close(type: 'S' | 'P', name: string): void {
    this.#con.close({ type, name })
  }

  sync(): void {
    this.#con.sync()
  }

  flush(): void {
    this.#con.flush()
  }

  /** The next message from upstream. */
  next(): Promise<UpstreamMessage> {
    const message = this.#queue.shift()
    if (message) return Promise.resolve(message)
    if (this.#failure) return Promise.reject(this.#failure)
    return new Promise((resolve, reject) => (this.#waiting = { resolve, reject }))
  }

  /** Ask the server to cancel the running statement, on a connection of its own. */
  cancel(): void {
    const { host, port } = this.#client as unknown as { host: string; port: number }
    const request = Buffer.alloc(16)
    request.writeInt32BE(16, 0)
    request.writeInt32BE(80877102, 4)
    request.writeInt32BE(this.processID, 8)
    request.writeInt32BE(this.secretKey, 12)
    const socket = host.startsWith('/') ? connect(`${host}/.s.PGSQL.${port}`) : connect(port, host)
    socket.on('connect', () => socket.end(request))
    socket.on('error', () => {})
  }

  async end(): Promise<void> {
    await this.#client.end().catch(() => {})
  }

  #push(message: UpstreamMessage): void {
    const waiting = this.#waiting
    if (waiting) {
      this.#waiting = undefined
      waiting.resolve(message)
    } else this.#queue.push(message)
  }

  #fail(error: Error): void {
    this.#failure ??= error
    const waiting = this.#waiting
    this.#waiting = undefined
    waiting?.reject(this.#failure)
  }
}
