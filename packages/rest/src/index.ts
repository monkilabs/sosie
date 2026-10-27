import { readFileSync } from 'node:fs'
import type { Connection, Source } from '@sosie/core'
import { startEndpoint } from './endpoint.js'
import { requestTool } from './mcp.js'
import { parseDocument, readApi, type Api } from './openapi.js'
import { parseHeaders, RestUpstream } from './upstream.js'

/** Where an API usually serves its OpenAPI document, relative to its base. */
const DISCOVER = ['openapi.json', 'openapi.yaml', 'swagger.json', 'v3/api-docs', 'api-docs', 'docs/openapi.json']

/** The REST source: a local HTTP endpoint in front of the team's own API, GET only, every JSON value faked. */
export const rest: Source = {
  kind: 'rest',
  matches: (url) => url.protocol === 'http:' || url.protocol === 'https:',
  async connect(upstream, options): Promise<Connection> {
    const env = options.env ?? {}
    const headers = parseHeaders(env.SOSIE_UPSTREAM_HEADERS)
    if (upstream.username) {
      const user = decodeURIComponent(upstream.username)
      const password = decodeURIComponent(upstream.password)
      headers.authorization ??= `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
    }
    const base = new URL(upstream.href)
    base.username = base.password = base.search = base.hash = ''
    base.pathname = base.pathname.replace(/\/?$/, '/')
    const api = new RestUpstream(base, headers, options.statementTimeout)
    const label = `${base.host}${base.pathname.replace(/\/$/, '')}`

    const warnings: string[] = []
    let doc: Api | undefined
    if (env.SOSIE_OPENAPI) {
      try {
        doc = readApi(parseDocument(await readDocument(env.SOSIE_OPENAPI, api)))
      } catch (error) {
        throw new Error(`SOSIE_OPENAPI: ${(error as Error).message}`)
      }
    } else {
      let reached = false
      let reason = ''
      for (const path of DISCOVER) {
        try {
          const answer = await api.get(new URL(path, base))
          reached = true
          if (answer.status !== 200) continue
          doc = readApi(parseDocument(answer.body))
          break
        } catch (error) {
          if (!reached) reason = (error as Error).message
        }
      }
      if (!reached) throw new Error(`Cannot reach ${label}: ${reason}`)
      if (!doc) {
        warnings.push(
          'No OpenAPI document found: fields are named by where values sit (user.email). Set SOSIE_OPENAPI to a file or URL to name them from one.',
        )
      }
    }
    const operations = doc?.operations.length ?? 0
    return {
      schema: doc?.schema ?? { entities: [] },
      label,
      summary: doc ? `${doc.version}, ${doc.schema.entities.length} schemas, ${operations} GET ${operations === 1 ? 'path' : 'paths'}` : 'no OpenAPI document',
      warnings,
      learns: !doc,
      client: 'curl',
      serve: (listen, faker) => startEndpoint(listen, { upstream: api, api: doc, faker, log: (line) => process.stderr.write(`  ! ${line}\n`) }),
      async close() {},
    }
  },
  tools: [requestTool],
}

/** An OpenAPI document from a file, or a URL: through the API's credentials when it is the API's own. */
async function readDocument(location: string, api: RestUpstream): Promise<string> {
  if (!/^https?:\/\//i.test(location)) return readFileSync(location, 'utf8')
  const url = new URL(location)
  if (url.origin === api.base.origin) return (await api.get(url)).body
  const response = await fetch(url, { signal: AbortSignal.timeout(api.timeout) })
  return response.text()
}

export { parseDocument, readApi } from './openapi.js'
export { route, singular } from './paths.js'
export { parseHeaders } from './upstream.js'
