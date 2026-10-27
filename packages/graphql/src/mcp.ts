import { capLists, type McpTool } from '@sosie/core'

const MAX_ITEMS = 200

/** The GraphQL source's MCP tool: a query through the running endpoint, never to the API itself. */
export const graphqlTool: McpTool = {
  name: 'graphql',
  description:
    'Run a GraphQL query on the API through Sosie. Every value is a consistent fake: the same real value is always ' +
    'the same fake, so an id you saw finds its record again as an argument. Mutations are refused.',
  input: {
    query: { description: 'The GraphQL query, such as { users { id email } }.' },
    variables: { description: 'Its variables as JSON, such as {"id": "87"}.', optional: true },
  },
  async run(input, running) {
    let variables: unknown
    try {
      variables = input.variables ? JSON.parse(input.variables) : undefined
    } catch {
      throw new Error('The variables are not JSON: write them as {"id": "87"}.')
    }
    const response = await fetch(running.address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: input.query ?? '', ...(variables !== undefined && { variables }) }),
    })
    const capped = capLists(await response.json(), MAX_ITEMS)
    return capped.cut ? { ...(capped.value as object), note: `Only the first ${MAX_ITEMS} items of each list are shown.` } : capped.value
  },
}
