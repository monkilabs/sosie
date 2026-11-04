import { createServer, type Server, type Socket } from 'node:net'
import type { Endpoint } from '@sosie/core'
import { Session, type SessionContext } from './session.js'

/** The local address clients connect to: a MySQL server that answers with fakes. */
export async function startEndpoint(listen: { host: string; port: number }, database: string, ctx: SessionContext): Promise<Endpoint> {
  const sockets = new Set<Socket>()
  const accept = (socket: Socket) => {
    socket.setNoDelay(true)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    void new Session(socket, ctx, database).run()
  }
  const servers = await listenLocal(listen, accept)
  const bound = servers[0]!.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
  // 127.0.0.1, not localhost: MySQL's own client takes localhost for its Unix socket.
  const host = listen.host === '::1' ? '[::1]' : listen.host
  return {
    address: `mysql://${host}:${port}/${encodeURIComponent(database)}`,
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
