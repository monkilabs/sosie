/**
 * What the sources that serve HTTP share: reading an upstream's body within
 * a cap, answering local clients only, and faking a large body without
 * keeping other clients waiting.
 */

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

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/**
 * Whether a request's Host header names this machine, for an endpoint
 * listening on it: a web page that rebinds its own name to 127.0.0.1 sends
 * its name, and is refused. On another --host, any name is answered.
 */
export function localRequest(host: string | undefined, listening: string): boolean {
  if (!LOOPBACK.has(listening)) return true
  const name = (host ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return LOOPBACK.has(name)
}

/** A pause every so many values, so faking one large body lets other clients in between. */
export function pacer(every = 256): () => Promise<void> | undefined {
  let count = 0
  return () => (++count % every === 0 ? new Promise<void>((resolve) => setImmediate(resolve)) : undefined)
}
