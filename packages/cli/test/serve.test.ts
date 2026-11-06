import { createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PORTS_TO_TRY, serveAll, type Listener } from '../src/serve.js'

function listen(port: number, host = '127.0.0.1'): Promise<Server> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** Every server a test started: a source's, or one holding a port as another program would. */
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) if (server.listening) await close(server)
})

/**
 * `n` ports in a row, each held here as another program would hold it. They are below the ports a system hands out
 * for port 0, from 32768 on Linux and 49152 on macOS, and far from Sosie's, so no other test takes one meanwhile.
 */
async function held(n: number): Promise<{ first: number; holders: Server[] }> {
  for (;;) {
    const first = 20_000 + Math.floor(Math.random() * 10_000)
    const holders: Server[] = []
    try {
      for (let i = 0; i < n; i++) holders.push(await listen(first + i))
      servers.push(...holders)
      return { first, holders }
    } catch {
      for (const holder of holders) await close(holder)
    }
  }
}

/** A source that listens for real, on a TCP server of its own; its address is its port. */
const source = (name: string, port?: number, host = '127.0.0.1'): Listener => ({
  name,
  port,
  listen: async (at) => {
    const server = await listen(at, host)
    servers.push(server)
    return { address: String((server.address() as AddressInfo).port), close: () => close(server) }
  },
})

const ports = (endpoints: { address: string }[]) => endpoints.map((e) => Number(e.address))

describe('serving every source', () => {
  it('listens on the next free port from the first, past one taken, and keeps a port given for its own source', async () => {
    const { first, holders } = await held(4)
    // first + 1 stays taken; first + 2 is b's, though c comes before it.
    for (const i of [0, 2, 3]) await close(holders[i]!)
    const endpoints = await serveAll([source('a'), source('c'), source('b', first + 2)], first)
    expect(ports(endpoints)).toEqual([first, first + 3, first + 2])
  })

  it('listens on the port the system picks for port 0, never on one it finds from the first', async () => {
    const { first, holders } = await held(1)
    await close(holders[0]!)
    const [a, b] = ports(await serveAll([source('a', 0), source('b')], first))
    expect(a).not.toBe(first)
    expect(b).toBe(first)
  })

  it(`gives up past ${PORTS_TO_TRY} taken ports, saying which, and closes the endpoints already listening`, async () => {
    const { first } = await held(PORTS_TO_TRY)
    const before = servers.length
    await expect(serveAll([source('a', 0), source('b')], first)).rejects.toThrow(`b: no port is free from ${first} to ${first + PORTS_TO_TRY - 1}. Give it one in sosie.yml.`)
    expect(servers.slice(before).map((s) => s.listening)).toEqual([false])
  })

  it('names a port given that is in use, and closes the endpoints already listening', async () => {
    const { first } = await held(1)
    const before = servers.length
    await expect(serveAll([source('a', 0), source('b', first)], first + 1)).rejects.toThrow(`b: port ${first} is in use. Is Sosie already running? Give it another in sosie.yml.`)
    expect(servers.slice(before).map((s) => s.listening)).toEqual([false])
  })

  it('tells why a source cannot listen, other than a port in use, at once: on a port given and on one it finds', async () => {
    const { first, holders } = await held(1)
    await close(holders[0]!)
    // 192.0.2.1 is for documentation: no machine has it, so nothing can listen on it.
    const before = servers.length
    await expect(serveAll([source('a', 0), source('b', first, '192.0.2.1')], first)).rejects.toThrow(`b: listen EADDRNOTAVAIL: address not available 192.0.2.1:${first}`)
    await expect(serveAll([source('a', 0), source('c', undefined, '192.0.2.1')], first)).rejects.toThrow(`c: listen EADDRNOTAVAIL: address not available 192.0.2.1:${first}`)
    expect(servers.slice(before).map((s) => s.listening)).toEqual([false, false])
  })
})
