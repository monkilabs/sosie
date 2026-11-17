import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import tls, { type SecureContext, type TLSSocket } from 'node:tls'
import { HEADER, PACKET, packets } from './tds.js'

const APPLICATION_DATA = 23

/**
 * The bytes under a TLS socket. TDS 7.x carries the handshake in PRELOGIN packets, each flight one message, and
 * after it TLS's records go bare on the socket, TDS's packets inside them. TDS 8 is bare throughout. A record says
 * what it is by its first byte: handshake (22) and change cipher spec (20) records are wrapped until the first
 * application data (23) goes out. A packet starts with its type, 0x12 or 0x04, which no record does.
 */
class Carrier extends Duplex {
  #in: Buffer
  #out: Buffer = Buffer.alloc(0)
  #pending: Buffer[] = []
  #rawIn: boolean
  #rawOut: boolean
  #sink: ((chunk: Buffer) => void) | undefined

  constructor(
    private readonly socket: Socket,
    framed: boolean,
    leftover: Buffer = Buffer.alloc(0),
  ) {
    super()
    this.#in = leftover
    this.#rawIn = !framed
    this.#rawOut = !framed
    socket.on('data', (chunk: Buffer) => {
      this.#in = this.#in.length ? Buffer.concat([this.#in, chunk]) : chunk
      this.#drain()
    })
    socket.on('end', () => this.push(null))
    socket.on('error', (error) => this.destroy(error))
    socket.on('close', () => this.push(null))
    queueMicrotask(() => this.#drain())
  }

  #drain(): void {
    if (this.#sink) {
      if (this.#in.length) this.#sink(this.#in)
      this.#in = Buffer.alloc(0)
      return
    }
    while (this.#in.length) {
      const first = this.#in[0]
      if (!this.#rawIn && (first === PACKET.PRELOGIN || first === PACKET.REPLY)) {
        if (this.#in.length < HEADER) return
        const length = this.#in.readUInt16BE(2)
        if (length < HEADER) return void this.destroy(new Error('A TDS packet shorter than its header, in a TLS handshake.'))
        if (this.#in.length < length) return
        this.push(this.#in.subarray(HEADER, length))
        this.#in = this.#in.subarray(length)
      } else {
        this.#rawIn = true
        this.push(this.#in)
        this.#in = Buffer.alloc(0)
      }
    }
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.#rawOut) {
      this.socket.write(chunk, callback)
      return
    }
    this.#out = this.#out.length ? Buffer.concat([this.#out, chunk]) : chunk
    while (this.#out.length >= 5) {
      const length = 5 + this.#out.readUInt16BE(3)
      if (this.#out.length < length) break
      const record = this.#out.subarray(0, length)
      this.#out = this.#out.subarray(length)
      // An alert in the handshake goes wrapped, as its flight does; once application data goes out, every record is bare.
      if (record[0] === APPLICATION_DATA) {
        this.#flush()
        this.#rawOut = true
        this.socket.write(record)
      } else {
        this.#pending.push(record)
        if (this.#pending.length === 1) setImmediate(() => this.#flush())
      }
    }
    callback()
  }

  /** One flight of the handshake, as one PRELOGIN message: each side reads one in answer to each it sends. */
  #flush(): void {
    if (!this.#pending.length) return
    this.socket.write(packets(PACKET.PRELOGIN, Buffer.concat(this.#pending)))
    this.#pending = []
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#flush()
    this.socket.end()
    callback()
  }

  /** From now on what comes is TDS in clear, given to `sink`: a login encrypted only for its LOGIN7. */
  bare(sink: (chunk: Buffer) => void): void {
    this.#sink = sink
    this.#drain()
  }
}

/**
 * TLS for a client of the endpoint: TDS 8's, first, when it opened with a ClientHello (`leftover` holds what it sent);
 * else TDS 7.4's, inside PRELOGIN packets, at TLS 1.2 as SQL Server serves it.
 */
export function acceptTls(socket: Socket, strict: boolean, context: (strict: boolean) => SecureContext, leftover: Buffer = Buffer.alloc(0)): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const carrier = new Carrier(socket, !strict, leftover)
    const secure = new tls.TLSSocket(carrier, {
      isServer: true,
      secureContext: context(strict),
      ...(strict && { ALPNProtocols: ['tds/8.0'] }),
    })
    secure.once('secure', () => {
      secure.off('error', reject)
      resolve(secure)
    })
    secure.once('error', reject)
    socket.resume()
  })
}

export interface ClientTlsOptions {
  /** TDS 8: TLS before anything else, with ALPN tds/8.0. */
  strict: boolean
  /** The name the certificate must have; an address checks the certificate's IP addresses. */
  host: string
  /** Check the certificate: false only where the connection string trusts any (trustServerCertificate). */
  verify: boolean
  /** A CA to trust beside the system's, such as Sosie's own, for a client of Sosie's endpoint. */
  ca?: string | Buffer
}

export interface ClientTls {
  socket: TLSSocket
  /** Drop TLS after the login: SQL Server encrypts only LOGIN7 when neither side asked for more. */
  bare?: (sink: (chunk: Buffer) => void) => void
}

/** TLS to a SQL Server: TDS 8's on the bare socket, or TDS 7.4's inside PRELOGIN packets. */
export function connectTls(socket: Socket, options: ClientTlsOptions): Promise<ClientTls> {
  return new Promise((resolve, reject) => {
    const carrier = options.strict ? undefined : new Carrier(socket, true)
    const secure = tls.connect({
      socket: carrier ?? socket,
      host: options.host,
      // RFC 6066 has no server name for an address.
      servername: /^[\d.]+$|:/.test(options.host) ? '' : options.host,
      rejectUnauthorized: options.verify,
      minVersion: 'TLSv1.2',
      ...(options.strict ? { ALPNProtocols: ['tds/8.0'] } : { maxVersion: 'TLSv1.2' as const }),
      ...(options.ca && { ca: [...tls.rootCertificates, String(options.ca)] }),
    })
    secure.once('secureConnect', () => {
      secure.off('error', reject)
      resolve({ socket: secure, ...(carrier && { bare: (sink: (chunk: Buffer) => void) => carrier.bare(sink) }) })
    })
    secure.once('error', reject)
  })
}
