import { readCapped } from '@sosie/core'

/** The API upstream: credentials Sosie holds, same-origin redirects only, a timeout and a size cap. */
export interface UpstreamResponse {
  /** Where the answer came from, after redirects within the API. */
  url: URL
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
    /** Query parameters SOSIE_UPSTREAM carries, such as an api_key: sent with every request, never shown. */
    readonly params = new URLSearchParams(),
  ) {}

  async get(url: URL, method: 'GET' | 'HEAD' = 'GET'): Promise<UpstreamResponse> {
    let current = url
    for (let hop = 0; ; hop++) {
      for (const [name, value] of this.params) current.searchParams.set(name, value)
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
        await response.body?.cancel()
        current = next
        continue
      }
      const body = method === 'HEAD' ? '' : await readCapped(response, MAX_BODY)
      return { url: current, status: response.status, type: response.headers.get('content-type') ?? '', body }
    }
  }
}
