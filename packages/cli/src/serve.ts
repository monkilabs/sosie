import type { Endpoint } from '@sosie/core'

/** The first port a source without one tries, then each next one; 7674 spells "sosi" on a phone keypad. */
export const FIRST_PORT = 7674
/** Ports past a taken one a source without a port tries before it gives up. */
export const PORTS_TO_TRY = 100

/** A source to serve: its name, the port sosie.yml gives it if any, and how it listens on a port. */
export interface Listener {
  name: string
  port?: number
  listen(port: number): Promise<Endpoint>
}

/**
 * Each source's endpoint: on its port, or the next free one from `first`, in the order listed, the given ports kept
 * for their sources. One that cannot listen closes those that did, and throws what to tell.
 */
export async function serveAll(listeners: Listener[], first = FIRST_PORT): Promise<Endpoint[]> {
  const given = new Set(listeners.map((l) => l.port).filter((p): p is number => !!p))
  const endpoints: Endpoint[] = []
  const closeAll = async () => {
    for (const endpoint of endpoints) await endpoint.close().catch(() => {})
  }
  let next = first
  for (const { name, port: chosen, listen } of listeners) {
    if (chosen !== undefined) {
      try {
        endpoints.push(await listen(chosen))
        continue
      } catch (error) {
        await closeAll()
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`${name}: port ${chosen} is in use. Is Sosie already running? Give it another in sosie.yml.`)
        throw new Error(`${name}: ${(error as Error).message}`)
      }
    }
    for (let port = next, tries = 0; ; port++) {
      if (given.has(port)) continue
      try {
        endpoints.push(await listen(port))
        next = port + 1
        break
      } catch (error) {
        const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        if (busy && ++tries < PORTS_TO_TRY) continue
        await closeAll()
        throw new Error(`${name}: ${busy ? `no port is free from ${next} to ${port}. Give it one in sosie.yml.` : (error as Error).message}`)
      }
    }
  }
  return endpoints
}
