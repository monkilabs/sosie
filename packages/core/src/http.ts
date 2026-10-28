/**
 * What the sources that serve HTTP share: reading an upstream's body within
 * a cap, answering local clients and pages only, and faking a large body
 * without keeping other clients waiting.
 */

import type { IncomingHttpHeaders } from 'node:http'

/** A response's body as text, refused as soon as it passes `max` bytes, whatever its content-length says. */
export async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > max) {
    await response.body?.cancel()
    throw new Error(`The API answered with ${declared} bytes; Sosie fakes up to ${max}.`)
  }
  if (!response.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > max) {
      await response.body.cancel().catch(() => {})
      throw new Error(`The API answered with more than ${max} bytes; Sosie fakes up to that.`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Why a request failed, with the cause fetch keeps behind "fetch failed": a refused connection, a TLS error, a name not found. */
export function why(error: unknown): string {
  const { message, cause } = error as Error & { cause?: { message?: string; code?: string } }
  const reason = cause?.message ?? cause?.code
  return reason && !message.includes(reason) ? `${message}: ${reason}` : message
}

/** Whether a name or address is this machine's own: localhost, ::1, or any address of 127.0.0.0/8. */
const loopback = (name: string) => name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)

/**
 * Whether a request's Host header names this machine, for an endpoint
 * listening on it: a web page that rebinds its own name to 127.0.0.1 sends
 * its name, and is refused. On another --host, any name is answered.
 */
export function localRequest(host: string | undefined, listening: string): boolean {
  if (!loopback(listening)) return true
  const name = (host ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return loopback(name)
}

/**
 * Whether a browser sent a request for a page of another site, to an endpoint
 * listening on this machine: any web page may send a GET to localhost, which
 * Sosie would send on with its own credentials. A page of this machine (an
 * app on another port) may; clients that are not browsers send neither header.
 */
export function crossSite(headers: IncomingHttpHeaders, listening: string): boolean {
  if (!loopback(listening)) return false
  const origin = headers.origin
  if (origin === undefined) return headers['sec-fetch-site'] === 'cross-site'
  try {
    return !loopback(new URL(origin).hostname.replace(/^\[(.*)\]$/, '$1'))
  } catch {
    // Origin: null, from a sandboxed frame or a file, is no page of this machine's.
    return true
  }
}

/** A pause every so many values, so faking one large body lets other clients in between. */
export function pacer(every = 256): () => Promise<void> | undefined {
  let count = 0
  return () => (++count % every === 0 ? new Promise<void>((resolve) => setImmediate(resolve)) : undefined)
}
