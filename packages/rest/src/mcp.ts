import { capLists, type McpTool } from '@sosie/core'

const MAX_ITEMS = 200

/** The REST source's MCP tool: a GET through the running endpoint, never to the API itself. */
export const requestTool: McpTool = {
  name: 'request',
  description:
    'Send a GET request to the API through Sosie and get its JSON back. Every value is a consistent fake: ' +
    'the same real value is always the same fake, so an id you saw finds its record again in a path or query.',
  input: { path: { description: 'The path and query, such as /users?limit=10.' } },
  async run(input, running) {
    const base = new URL(running.address)
    const basePath = base.pathname.replace(/\/$/, '')
    let path = input.path ?? '/'
    if (!path.startsWith('/')) path = `/${path}`
    if (basePath && path !== basePath && !path.startsWith(`${basePath}/`) && !path.startsWith(`${basePath}?`)) path = `${basePath}${path}`
    const url = new URL(path, base.origin)
    // A path such as //host/x names another host: the tool reaches Sosie only.
    if (url.origin !== base.origin) throw new Error('The path must be a path of the API, such as /users?limit=10.')
    const response = await fetch(url)
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // Sosie answers with JSON; anything else is shown as text.
    }
    const capped = capLists(body, MAX_ITEMS)
    const notes = [response.headers.get('sosie-notice'), capped.cut && `Only the first ${MAX_ITEMS} items of each list are shown.`].filter(Boolean)
    return { status: response.status, body: capped.value, ...(notes.length && { note: notes.join(' ') }) }
  },
}
