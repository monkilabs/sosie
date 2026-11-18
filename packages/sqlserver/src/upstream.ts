import { connect as tcp, type Socket } from 'node:net'
import { PassThrough, type Duplex } from 'node:stream'
import { ENCRYPT, FEATURE, login7, OPTION, prelogin, READ_ONLY_INTENT, readPrelogin, TDS, tdsRank, versionBytes, type Login7 } from './login.js'
import { allHeaders, Messages, PACKET, packets, STATUS, type Message } from './tds.js'
import { connectTls } from './tls.js'
import { DONE, ENV, readTokens, TOKEN, type Column, type Message as TdsMessage } from './tokens.js'
import { textOf } from './types.js'

/** Where a SQL Server is, and how Sosie logs in to it: from its connection string, sqlserver://user:password@host:1433/database. */
export interface Target {
  host: string
  port: number
  database: string
  user: string
  password: string
  /** strict: TDS 8, TLS first; on: TLS inside TDS; off: TLS for the login only, or none where the server has none. */
  encrypt: 'strict' | 'on' | 'off'
  /** Check the server's certificate: what trustServerCertificate=true turns off. */
  verify: boolean
  /** The name the certificate must have, when it is not the host's: hostNameInCertificate. */
  certificateHost?: string
  readOnlyIntent: boolean
  /** A CA to trust beside the system's. */
  ca?: string
}

const TRUE = /^(true|yes|1|on)$/i

/** The connection string's settings, case aside: encrypt, trustServerCertificate, hostNameInCertificate, applicationIntent. */
export function targetOf(url: URL): Target {
  const params = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]))
  const encrypt = (params.get('encrypt') ?? 'true').toLowerCase()
  return {
    host: decodeURIComponent(url.hostname).replace(/^\[(.*)\]$/, '$1') || 'localhost',
    port: Number(url.port || 1433),
    database: decodeURIComponent(url.pathname.slice(1)) || params.get('database') || params.get('databasename') || '',
    user: decodeURIComponent(url.username) || params.get('user') || '',
    password: decodeURIComponent(url.password) || params.get('password') || '',
    encrypt: encrypt === 'strict' ? 'strict' : TRUE.test(encrypt) || encrypt === 'mandatory' ? 'on' : 'off',
    verify: !TRUE.test(params.get('trustservercertificate') ?? 'false'),
    ...(params.get('hostnameincertificate') && { certificateHost: params.get('hostnameincertificate')! }),
    readOnlyIntent: /^readonly$/i.test(params.get('applicationintent') ?? ''),
  }
}

/** What a login said of the session. */
export interface Session {
  /** The server's version, from LOGINACK: 16.0.4325. */
  version: string
  /** LOGINACK's program name and version, given to clients as the server's. */
  program: string
  programVersion: Buffer
  tdsVersion: number
  database: string
  language: string
  collation: Buffer
  packetSize: number
}

export interface Reply {
  /** Every token of the reply; not an attention's acknowledgment, which answers the attention. */
  payload: Buffer
  /** Sosie stopped the request at its time limit: the reply's tokens are what the server sent before it stopped. */
  timedOut: boolean
  /** An attention stopped the request, Sosie's or the client's, and the server acknowledged it. */
  stopped?: boolean
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly tds?: TdsMessage,
  ) {
    super(message)
  }
}

/** How long a statement Sosie stopped has to say so before its session is dropped. */
const ATTENTION_GRACE = 5000
const CONNECT_TIMEOUT = 15_000

/** One session to a SQL Server: a client's, or Sosie's own. */
export class Upstream {
  readonly #messages: Messages
  readonly #write: (bytes: Buffer) => void
  readonly #socket: Socket
  #attention = false
  #closed = false

  private constructor(
    socket: Socket,
    io: { messages: Messages; write: (bytes: Buffer) => void },
    readonly session: Session,
  ) {
    this.#socket = socket
    this.#messages = io.messages
    this.#write = io.write
  }

  /**
   * Log in: Sosie's login from the target, the rest of LOGIN7 from `login`, a client's. Azure SQL may route the login
   * to another server, where it logs in again.
   */
  static async open(target: Target, login: Partial<Login7> = {}): Promise<Upstream> {
    let at = { host: target.host, port: target.port }
    for (let hops = 0; ; hops++) {
      const { socket, io, response } = await logIn(target, at, login)
      const tokens = [...readTokens(response.payload)]
      const failed = tokens.find((t) => t.kind === 'message' && t.error)
      if (failed && failed.kind === 'message') {
        socket.destroy()
        throw new UpstreamError(failed.text, failed)
      }
      const routing = tokens.find((t) => t.kind === 'envchange' && t.type === ENV.ROUTING)
      if (routing && routing.kind === 'envchange' && hops < 3) {
        socket.destroy()
        at = routed(routing.data)
        continue
      }
      const ack = tokens.find((t) => t.kind === 'loginack')
      if (!ack || ack.kind !== 'loginack') {
        socket.destroy()
        throw new UpstreamError('The server did not acknowledge the login.')
      }
      const session: Session = {
        version: `${ack.version[0]}.${ack.version[1]}.${ack.version.readUInt16BE(2)}`,
        program: ack.program,
        programVersion: Buffer.from(ack.version),
        tdsVersion: ack.tds,
        database: target.database,
        language: '',
        collation: Buffer.alloc(5),
        packetSize: login.packetSize ?? 8000,
      }
      for (const t of tokens) {
        if (t.kind !== 'envchange') continue
        if (t.type === ENV.DATABASE) session.database = envText(t.data)
        if (t.type === ENV.LANGUAGE) session.language = envText(t.data)
        if (t.type === ENV.PACKET_SIZE) session.packetSize = Number(envText(t.data)) || session.packetSize
        if (t.type === ENV.COLLATION) session.collation = Buffer.from(t.data.subarray(2, 2 + (t.data[1] ?? 0)))
      }
      return new Upstream(socket, io, session)
    }
  }

  /**
   * Send a request and read its reply whole. Past `timeout`, Sosie sends an attention, as a driver's own timeout
   * does, and the reply is what came before the server stopped. `cancel` stops it as soon as it is sent: the client
   * cancelled it before it went. A reply an attention stopped comes without the server's acknowledgment.
   */
  async request(type: number, payload: Buffer, { status = 0, timeout = 0, cancel = false }: { status?: number; timeout?: number; cancel?: boolean } = {}): Promise<Reply> {
    if (this.#attention) await this.#acknowledged([])
    this.#write(packets(type, payload, this.session.packetSize, status & (STATUS.RESET | STATUS.RESET_SKIP_TRAN)))
    if (cancel) this.attention()
    let timedOut = false
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true
          this.attention()
        }, timeout)
      : undefined
    try {
      const first = await this.#next()
      const parts = [first.payload]
      if (!this.#attention) return { payload: first.payload, timedOut }
      await this.#acknowledged(parts)
      // The acknowledgment is the attention's answer, not the request's: its DONE is the last of what came.
      const all = Buffer.concat(parts)
      return { payload: all.subarray(0, all.length - DONE_LENGTH), timedOut, stopped: true }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Stop the request running: its reply ends with a DONE that says so. */
  attention(): void {
    if (this.#attention || this.#closed) return
    this.#attention = true
    this.#write(packets(PACKET.ATTENTION, Buffer.alloc(0), this.session.packetSize))
  }

  /** Read on until the attention is acknowledged, keeping what comes in `parts`; past the grace, the session is dropped. */
  async #acknowledged(parts: Buffer[]): Promise<void> {
    const timer = setTimeout(() => this.#socket.destroy(), ATTENTION_GRACE)
    try {
      while (!acknowledges(parts.at(-1))) parts.push((await this.#next()).payload)
      this.#attention = false
    } finally {
      clearTimeout(timer)
    }
  }

  async #next(): Promise<Message> {
    const message = await this.#messages.next()
    if (!message) throw new UpstreamError('The upstream session ended.')
    return message
  }

  /** A batch of Sosie's own, its errors thrown. */
  async batch(sql: string, timeout = 0): Promise<Buffer> {
    const reply = await this.request(PACKET.BATCH, Buffer.concat([allHeaders(), Buffer.from(sql, 'utf16le')]), { timeout })
    for (const t of readTokens(reply.payload)) if (t.kind === 'message' && t.error) throw new UpstreamError(t.text, t)
    if (reply.timedOut) throw new UpstreamError('Sosie stopped the statement at its time limit.')
    return reply.payload
  }

  /** Rows of a query of Sosie's own, each value as text: the catalog's. */
  async rows(sql: string): Promise<Record<string, string | null>[]> {
    const out: Record<string, string | null>[] = []
    let columns: Column[] = []
    for (const t of readTokens(await this.batch(sql))) {
      if (t.kind === 'colmetadata' && t.columns) columns = t.columns
      if (t.kind === 'row') out.push(Object.fromEntries(columns.map((c, i) => [c.name, t.values[i]!.bytes === null ? null : (textOf(c.type, t.values[i]!.bytes!) ?? null)])))
    }
    return out
  }

  close(): void {
    this.#closed = true
    this.#socket.destroy()
  }
}

/** A DONE token's length: its type, status, current command and row count. */
const DONE_LENGTH = 13

/** Whether a reply's last token is the DONE that acknowledges an attention. */
function acknowledges(payload: Buffer | undefined): boolean {
  if (!payload || payload.length < DONE_LENGTH) return false
  const at = payload.length - DONE_LENGTH
  return payload[at] === TOKEN.DONE && (payload.readUInt16LE(at + 1) & DONE.ATTN) !== 0
}

/** An ENVCHANGE's new value, as text. */
function envText(data: Buffer): string {
  const chars = data[1] ?? 0
  return data.subarray(2, 2 + chars * 2).toString('utf16le')
}

/** Where Azure SQL routes a login: ENVCHANGE 20's protocol, port and server. */
function routed(data: Buffer): { host: string; port: number } {
  // Type, then the value's length (two bytes), its protocol (TCP, 0), port, and server as US_VARCHAR.
  const port = data.readUInt16LE(4)
  const chars = data.readUInt16LE(6)
  const server = data.subarray(8, 8 + chars * 2).toString('utf16le')
  return { host: server.split('\\')[0]!, port }
}

async function connectSocket(host: string, port: number): Promise<Socket> {
  const socket = tcp({ host, port })
  socket.setNoDelay(true)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no answer from ${host}:${port} in ${CONNECT_TIMEOUT / 1000} s`))
    }, CONNECT_TIMEOUT)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', reject)
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  socket.on('error', () => {})
  return socket
}

async function logIn(target: Target, at: { host: string; port: number }, login: Partial<Login7>) {
  const socket = await connectSocket(at.host, at.port)
  try {
    const tls = { host: target.certificateHost ?? at.host, verify: target.verify, ...(target.ca && { ca: target.ca }) }
    let duplex: Duplex = socket
    let bare: ((sink: (chunk: Buffer) => void) => void) | undefined
    if (target.encrypt === 'strict') duplex = (await connectTls(socket, { ...tls, strict: true })).socket
    const asked = target.encrypt === 'on' ? ENCRYPT.ON : target.encrypt === 'off' ? ENCRYPT.OFF : ENCRYPT.NOT_SUP
    const hello = new Messages(duplex)
    duplex.write(
      packets(
        PACKET.PRELOGIN,
        prelogin([
          [OPTION.VERSION, versionBytes('16.0.0')],
          [OPTION.ENCRYPTION, Buffer.from([asked])],
          [OPTION.INSTANCE, Buffer.from([0])],
          [OPTION.THREADID, Buffer.alloc(4)],
          [OPTION.MARS, Buffer.from([0])],
        ]),
      ),
    )
    const answer = await hello.next()
    if (!answer) throw new Error('the server closed the connection before PRELOGIN')
    const encryption = readPrelogin(answer.payload)[OPTION.ENCRYPTION]?.[0] ?? ENCRYPT.NOT_SUP
    // Messages read from now on come through what the session settles on; the PRELOGIN reader stops here.
    socket.removeAllListeners('data')
    if (duplex !== socket) duplex.removeAllListeners('data')
    let loginOnly = false
    if (target.encrypt !== 'strict') {
      if (encryption === ENCRYPT.NOT_SUP && target.encrypt === 'on') {
        throw new Error('the server does not support encryption: add encrypt=false to the connection string, and the session goes unencrypted')
      }
      if (encryption !== ENCRYPT.NOT_SUP) {
        const secure = await connectTls(socket, { ...tls, strict: false })
        duplex = secure.socket
        bare = secure.bare
        loginOnly = encryption === ENCRYPT.OFF && target.encrypt === 'off'
      }
    }
    const payload = login7({
      ...login,
      // The client's version, up to 7.4: so the server sends only the types the client reads. TDS 8 logs in as 7.4 does.
      tdsVersion: tdsRank(login.tdsVersion ?? TDS.V7_4) >= tdsRank(TDS.V7_4) ? TDS.V7_4 : login.tdsVersion!,
      packetSize: 8000,
      userName: target.user,
      password: target.password,
      serverName: at.host,
      database: target.database,
      typeFlags: (login.typeFlags ?? 0) | (target.readOnlyIntent ? READ_ONLY_INTENT : 0),
      sspi: Buffer.alloc(0),
      // UTF-8 collations' text as it is: asked for by Sosie's own sessions, and by a client's where the client asked.
      features: login.features ?? new Map([[FEATURE.UTF8, Buffer.alloc(0)]]),
    })
    let messages: Messages
    let write: (bytes: Buffer) => void
    if (loginOnly) {
      // SQL Server encrypts only LOGIN7 when neither side asked for more: what follows it goes in clear.
      const clear = new PassThrough()
      messages = new Messages(clear)
      duplex.write(packets(PACKET.LOGIN7, payload))
      bare!((chunk) => clear.write(chunk))
      socket.on('close', () => clear.end())
      write = (bytes) => socket.write(bytes)
    } else {
      messages = new Messages(duplex)
      duplex.write(packets(PACKET.LOGIN7, payload))
      write = (bytes) => duplex.write(bytes)
    }
    duplex.on('error', () => {})
    const response = await messages.next()
    if (!response) throw new Error('the server closed the connection during the login')
    return { socket, io: { messages, write }, response }
  } catch (error) {
    socket.destroy()
    throw error
  }
}
