import { createServer, type Socket } from 'node:net'
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
  const server = createServer((socket) => {
    socket.setNoDelay(true)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const session = new Session(socket, { ...ctx, cancel })
    sessions.add(session)
    void session.run().finally(() => sessions.delete(session))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const bound = server.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
  const host = listen.host === '127.0.0.1' || listen.host === '::1' ? 'localhost' : listen.host
  return {
    address: `postgres://${host.includes(':') ? `[${host}]` : host}:${port}/${encodeURIComponent(database)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      }),
  }
}
