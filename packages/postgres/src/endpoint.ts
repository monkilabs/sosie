import { createServer, type Server, type Socket } from 'node:net'
import type { Endpoint } from '@sosie/core'
import { Session, type SessionContext } from './session.js'

/** The local address clients connect to: a Postgres server that answers with fakes. */
export async function startEndpoint(
  listen: { host: string; port: number },
  database: string,
  ctx: Omit<SessionContext, 'cancel'>,
): Promise<Endpoint> {
  const sessions = new Set<Session>()
  const sockets = new Set<Socket>()
  const cancel = (pid: number, secret: number) => {
    for (const session of sessions) if (session.pid === pid && session.secret === secret) session.cancel()
  }
  const accept = (socket: Socket) => {
    socket.setNoDelay(true)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const session = new Session(socket, { ...ctx, cancel })
    sessions.add(session)
    void session.run().finally(() => sessions.delete(session))
  }

  const servers = [await listenOn(listen.host, listen.port, accept)]
  const bound = servers[0]!.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
  // The address says localhost, which many systems resolve to ::1 first: answer there too.
  if (listen.host === '127.0.0.1') await listenOn('::1', port, accept).then((s) => servers.push(s), () => {})
  const host = listen.host === '127.0.0.1' || listen.host === '::1' ? 'localhost' : listen.host
  return {
    address: `postgres://${host.includes(':') ? `[${host}]` : host}:${port}/${encodeURIComponent(database)}`,
    close: async () => {
      const closed = servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      for (const socket of sockets) socket.destroy()
      await Promise.all(closed)
    },
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
