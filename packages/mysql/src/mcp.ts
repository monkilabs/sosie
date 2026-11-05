import type { McpTool } from '@sosie/core'
import mysql from 'mysql2/promise'

const MAX_ROWS = 200

/* eslint-disable @typescript-eslint/no-explicit-any -- results as mysql2 returns them. */

/** The MySQL source's MCP tool: a query through the running endpoint, never to the upstream. */
export const queryTool: McpTool = {
  name: 'query',
  description:
    'Run read-only SQL on the database through Sosie. Up to 200 rows of each statement come back as JSON. ' +
    'Every value is a consistent fake: the same real value is always the same fake, so joins work, ' +
    'and a value you saw finds its row again in a WHERE clause.',
  input: { sql: { description: 'SQL, such as SELECT * FROM users LIMIT 10. Several statements return several results.' } },
  async run(input, running) {
    const url = new URL(running.address)
    const client = await mysql.createConnection({
      host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: Number(url.port),
      user: 'sosie_mcp',
      database: decodeURIComponent(url.pathname.slice(1)) || undefined,
      multipleStatements: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    })
    client.on('error', () => {})
    try {
      const [results, fields] = (await client.query(input.sql ?? '')) as [any, any]
      const several = Array.isArray(fields) && fields.some((f: unknown) => f === undefined || Array.isArray(f))
      const shaped = (several ? (results as unknown[]) : [results]).map(shape)
      // Sosie's own notes, a cut result's among them, are MySQL warnings.
      const [warnings] = (await client.query('SHOW WARNINGS')) as [{ Message: string }[], unknown]
      const notes = warnings.length ? { warnings: warnings.map((w) => w.Message) } : {}
      return shaped.length === 1 ? { ...shaped[0], ...notes } : { results: shaped, ...notes }
    } finally {
      await client.end().catch(() => {})
    }
  },
}

/** One statement's result: its rows, at most 200, bytes as hex; or how many rows it changed. */
function shape(result: any) {
  if (!Array.isArray(result)) return { rows: [], rowCount: Number(result?.affectedRows ?? 0) }
  return {
    rows: result.slice(0, MAX_ROWS).map((row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? `0x${value.toString('hex')}` : value])),
    ),
    rowCount: result.length,
    ...(result.length > MAX_ROWS && { note: `Only the first ${MAX_ROWS} of ${result.length} rows are shown. Narrow the query.` }),
  }
}
