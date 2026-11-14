import { readFileSync } from 'node:fs'
import { Credentials, readCapped, why, type Connection, type Source } from '@sosie/core'
import { startEndpoint } from './endpoint.js'
import { requestTool } from './mcp.js'
import { parseDocument, readApi, type Api } from './openapi.js'
import { RefusedPath, RestUpstream } from './upstream.js'

/**
 * Why, without a document, a rule for a field not met yet may never apply: an answer is an entity's only where its path
 * says so, which a singular name under a record never does.
 */
const WHY_UNMET =
  'A rule not known yet applies once an answer\'s path names its entity: /users and /users/87 name user. Under a record, only a list under a plural name does (/spaces/87/accounts); /spaces/87/account and /spaces/87/accounts/5 name none, so no rule applies to their answers. Give the source a schema, the API\'s OpenAPI document, to name every field from it.'

/** Where an API usually serves its OpenAPI document, relative to its base. */
const DISCOVER = ['openapi.json', 'openapi.yaml', 'swagger.json', 'v3/api-docs', 'api-docs', 'docs/openapi.json']

/** The REST source: a local HTTP endpoint in front of the team's own API, GET only, every JSON value faked. */
export const rest: Source = {
  kind: 'rest',
  title: 'REST API',
  schemes: ['http:', 'https:'],
  matches: (url) => url.protocol === 'http:' || url.protocol === 'https:',
  settings: ['headers', 'schema', 'refuse'],
  async connect(upstream, options): Promise<Connection> {
    const user = decodeURIComponent(upstream.username)
    const password = decodeURIComponent(upstream.password)
    const base = new URL(upstream.href)
    // A query on the base URL (?api_key=) is a credential too: sent upstream, never shown.
    const params = new URLSearchParams(base.search)
    base.username = base.password = base.search = base.hash = ''
    base.pathname = base.pathname.replace(/\/?$/, '/')
    const credentials = new Credentials(options.headers, { user, password, query: params.values() }, options.unauthorized)
    const api = new RestUpstream(base, credentials.headers, options.statementTimeout, params, options.refuse)
    const label = `${base.host}${base.pathname.replace(/\/$/, '')}`

    const warnings: string[] = []
    let doc: Api | undefined
    if (options.schema) {
      try {
        doc = readApi(parseDocument(await readDocument(options.schema, api)))
      } catch (error) {
        throw new Error(`Cannot read its schema: ${(error as Error).message}`)
      }
    } else {
      let reached = false
      let reason = ''
      let unreadable = ''
      for (const path of DISCOVER) {
        let found
        try {
          const answer = await api.get(new URL(path, base))
          reached = true
          if (answer.status !== 200) continue
          found = parseDocument(answer.body)
        } catch (error) {
          // A path sosie.yml refuses is never asked for, a document's included.
          if (!reached) reason = error instanceof RefusedPath ? reason || error.message : why(error)
          continue
        }
        try {
          doc = readApi(found)
          break
        } catch (error) {
          unreadable ||= `${path} (${(error as Error).message})`
        }
      }
      if (!reached) throw new Error(`Cannot reach ${label}: ${reason}`)
      if (!doc) {
        warnings.push(
          unreadable
            ? `The OpenAPI document at ${unreadable} cannot be read: fields are named by where values sit (user.email).`
            : 'No OpenAPI document found: fields are named by where values sit (user.email). Give the source a schema, a file or URL of its OpenAPI document, to name them from one.',
        )
      }
    }
    const operations = doc?.operations.length ?? 0
    const refused = options.refuse?.length ? `; refuses ${options.refuse.length} ${options.refuse.length === 1 ? 'path' : 'paths'}` : ''
    return {
      schema: doc?.schema ?? { entities: [] },
      label,
      summary: `${doc ? `${doc.version}, ${doc.schema.entities.length} schemas, ${operations} GET ${operations === 1 ? 'path' : 'paths'}` : 'no OpenAPI document'}${refused}`,
      warnings,
      learns: !doc,
      ...(!doc && { whyUnmet: WHY_UNMET }),
      serve: (listen, faker, learned) =>
        startEndpoint(listen, {
          upstream: api,
          api: doc,
          faker,
          maxItems: options.maxRows,
          secrets: credentials.secrets,
          answered: (status) => credentials.answered(status),
          log: (line) => process.stderr.write(`  ! ${line}\n`),
          ...(learned && { learned }),
        }),
      renew: (headers) => credentials.renew(headers),
      async close() {},
    }
  },
  tools: [requestTool],
}

/** An OpenAPI document from a file, or a URL: through the API's credentials when it is the API's own. */
async function readDocument(location: string, api: RestUpstream): Promise<string> {
  if (!/^https?:\/\//i.test(location)) return readFileSync(location, 'utf8')
  const url = new URL(location)
  const answered = (status: number) => new Error(`${url.host}${url.pathname} answered ${status}.`)
  if (url.origin === api.base.origin) {
    const answer = await api.get(url)
    if (answer.status !== 200) throw answered(answer.status)
    return answer.body
  }
  const response = await fetch(url, { headers: { 'user-agent': 'sosie' }, signal: AbortSignal.timeout(api.timeout) })
  if (response.status !== 200) {
    await response.body?.cancel()
    throw answered(response.status)
  }
  return readCapped(response, MAX_DOCUMENT)
}

/** A document's size at most, as an answer's. */
const MAX_DOCUMENT = 20 * 1024 * 1024

export { parseDocument, readApi } from './openapi.js'
export { route, singular } from './paths.js'
