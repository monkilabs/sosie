/** The API upstream: credentials Sosie holds, same-origin redirects only, a timeout and a size cap. */
export interface UpstreamResponse {
  status: number
  type: string
  body: string
}

const MAX_BODY = 20 * 1024 * 1024
const MAX_REDIRECTS = 5

export class RestUpstream {
  constructor(
    readonly base: URL,
    readonly headers: Record<string, string>,
    readonly timeout: number,
  ) {}

  async get(url: URL, method: 'GET' | 'HEAD' = 'GET'): Promise<UpstreamResponse> {
    let current = url
    for (let hop = 0; ; hop++) {
      const response = await fetch(current, {
        method,
        headers: { accept: 'application/json', 'user-agent': 'sosie', ...this.headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeout),
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current)
        // Credentials go to the API's own origin only.
        if (next.origin !== this.base.origin) throw new Error(`The API redirected to ${next.origin}; Sosie follows redirects within ${this.base.origin} only.`)
        if (hop >= MAX_REDIRECTS) throw new Error('The API redirected too many times.')
        current = next
        continue
      }
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > MAX_BODY) throw new Error(`The API answered with ${length} bytes; Sosie fakes up to ${MAX_BODY}.`)
      const body = method === 'HEAD' ? '' : await response.text()
      if (body.length > MAX_BODY) throw new Error(`The API answered with more than ${MAX_BODY} bytes; Sosie fakes up to that.`)
      return { status: response.status, type: response.headers.get('content-type') ?? '', body }
    }
  }
}

/** SOSIE_UPSTREAM_HEADERS: one `Name: value` per line, for the credentials the API wants. */
export function parseHeaders(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of (text ?? '').split(/\r?\n|\\n/)) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return headers
}
