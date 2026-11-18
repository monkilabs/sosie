import { createServer, type Server, type Socket } from 'node:net'
import { hostname } from 'node:os'
import tls, { type SecureContext } from 'node:tls'
import { sosieHome, type Endpoint } from '@sosie/core'
import { endpointCertificate } from './certificate.js'
import { Session, type SessionContext } from './session.js'

/** Hosts that stand for every address the machine has: the certificate names the machine too. */
const WILDCARDS = new Set(['0.0.0.0', '::', ''])

/**
 * The local address clients connect to: a SQL Server that answers with fakes. Its certificate, from Sosie's own CA
 * in SOSIE_HOME, names every host clients reach it by; the address it gives says TrustServerCertificate=true, so a
 * client that does not trust the CA connects all the same.
 */
export async function startEndpoint(listen: { host: string; port: number }, database: string, ctx: Omit<SessionContext, 'secureContext'>): Promise<Endpoint & { ca: string }> {
  const hosts = WILDCARDS.has(listen.host) ? [hostname()] : [listen.host, ...(/^(127\.|::1$|localhost$)/.test(listen.host) ? [] : [hostname()])]
  const certificate = endpointCertificate(sosieHome(), hosts)
  // TDS 7.4 carries TLS 1.2 at most in its packets, as SQL Server serves it: TLS 1.3's handshake would go out as
  // application data, which no driver reads there. TDS 8 takes TLS 1.3.
  const contexts = new Map<boolean, SecureContext>()
  const secureContext = (strict: boolean) => {
    let context = contexts.get(strict)
    if (!context) {
      context = tls.createSecureContext({ key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.2', maxVersion: strict ? 'TLSv1.3' : 'TLSv1.2' })
      contexts.set(strict, context)
    }
    return context
  }
  const sockets = new Set<Socket>()
  const accept = (socket: Socket) => {
    socket.setNoDelay(true)
    socket.on('error', () => {})
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    void new Session(socket, { ...ctx, secureContext }).run()
  }
  const servers = await listenLocal(listen, accept)
  const bound = servers[0]!.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
  return {
    address: `Server=${listen.host === '::1' ? '[::1]' : listen.host},${port};Database=${database};TrustServerCertificate=true`,
    ca: certificate.caPath,
    close: async () => {
      const closed = servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      for (const socket of sockets) socket.destroy()
      await Promise.all(closed)
    },
  }
}

/**
 * Listen where the address will say, and on ::1 too when it is 127.0.0.1: a client may take localhost there. A port
 * another program holds on ::1 counts as busy, and a port Sosie picks itself (0) is picked again.
 */
async function listenLocal(listen: { host: string; port: number }, accept: (socket: Socket) => void): Promise<Server[]> {
  for (let tries = 0; ; tries++) {
    const first = await listenOn(listen.host, listen.port, accept)
    const bound = first.address()
    if (listen.host !== '127.0.0.1' || !bound || typeof bound !== 'object') return [first]
    try {
      return [first, await listenOn('::1', bound.port, accept)]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return [first]
      await new Promise<void>((resolve) => first.close(() => resolve()))
      if (listen.port !== 0 || tries >= 10) throw error
    }
  }
}

function listenOn(host: string, port: number, accept: (socket: Socket) => void): Promise<Server> {
  const server = createServer(accept)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/** Where a client of the endpoint connects: its address's Server, as host and port, and its Database. */
export function parseAddress(address: string): { host: string; port: number; database: string } {
  const fields = new Map(
    address
      .split(';')
      .map((part) => part.split('='))
      .filter((kv): kv is [string, string] => kv.length === 2)
      .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]),
  )
  const server = (fields.get('server') ?? '').replace(/^tcp:/i, '')
  const comma = server.lastIndexOf(',')
  return {
    host: (comma >= 0 ? server.slice(0, comma) : server).replace(/^\[(.*)\]$/, '$1') || '127.0.0.1',
    port: Number(comma >= 0 ? server.slice(comma + 1) : 1433),
    database: fields.get('database') ?? '',
  }
}
