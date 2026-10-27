import type { McpTool } from '@sosie/core'

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
    const response = await fetch(running.address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: input.query ?? '', ...(input.variables && { variables: JSON.parse(input.variables) }) }),
    })
    return response.json()
  },
}
