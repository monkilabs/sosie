import type { McpTool } from '@sosie/core'
import pg from 'pg'

const MAX_ROWS = 200
const AS_TEXT = new Set([1082, 1083, 1114, 1184, 1266, 20, 1700])

/** The Postgres source's MCP tool: a query through the running endpoint, never to the upstream. */
export const queryTool: McpTool = {
  name: 'query',
  description:
    'Run one read-only SQL statement on the database through Sosie. Up to 200 rows come back as JSON. ' +
    'Every value is a consistent fake: the same real value is always the same fake, so joins work, ' +
    'and a value you saw finds its row again in a WHERE clause.',
  input: { sql: { description: 'One SQL statement, such as SELECT * FROM users LIMIT 10.' } },
  async run(input, running) {
    const client = new pg.Client({
      connectionString: running.address,
      application_name: 'sosie mcp',
      types: { getTypeParser: (oid: number, format?: string) => (AS_TEXT.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')) },
    })
    const notices: string[] = []
    client.on('notice', (n) => notices.push(n.message ?? ''))
    client.on('error', () => {})
    await client.connect()
    try {
      const results = await client.query(input.sql ?? '')
      const result = Array.isArray(results) ? results.at(-1)! : results
      const rows = result.rows ?? []
      return {
        rows: rows.slice(0, MAX_ROWS),
        rowCount: result.rowCount ?? rows.length,
        ...(rows.length > MAX_ROWS && { note: `Only the first ${MAX_ROWS} of ${rows.length} rows are shown. Narrow the query.` }),
        ...(notices.length && { notices }),
      }
    } finally {
      await client.end().catch(() => {})
    }
  },
}
