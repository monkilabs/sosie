import { readCapped } from '@sosie/core'

/** The GraphQL API upstream: Sosie's credentials, no redirects, a timeout and a size cap. */
export interface UpstreamAnswer {
  status: number
  type: string
  body: string
}

const MAX_BODY = 20 * 1024 * 1024

export class GraphqlUpstream {
  constructor(
    readonly url: URL,
    readonly headers: Record<string, string>,
    readonly timeout: number,
  ) {}

  async post(request: { query: string; variables?: Record<string, unknown>; operationName?: string }): Promise<UpstreamAnswer> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/graphql-response+json, application/json',
        'user-agent': 'sosie',
        ...this.headers,
      },
      body: JSON.stringify(request),
      // A POST is not followed elsewhere: its body and Sosie's credentials stay with the API.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeout),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error(`The API redirected (${response.status}); Sosie does not follow a GraphQL request elsewhere.`)
    }
    const body = await readCapped(response, MAX_BODY)
    return { status: response.status, type: response.headers.get('content-type') ?? '', body }
  }
}
