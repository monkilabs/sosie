import type { McpTool } from '@sosie/core'
import { parseAddress } from './endpoint.js'
import { allHeaders, PACKET } from './tds.js'
import { readTokens, type Column } from './tokens.js'
import { textOf, TYPE } from './types.js'
import { Upstream } from './upstream.js'

const MAX_ROWS = 200

/** The SQL Server source's MCP tool: a query through the running endpoint, never to the upstream. */
export const queryTool: McpTool = {
  name: 'query',
  description:
    'Run read-only T-SQL on the database through Sosie. Up to 200 rows of each statement come back as JSON. ' +
    'Every value is a consistent fake: the same real value is always the same fake, so joins work, ' +
    'and a value you saw finds its row again in a WHERE clause.',
  input: { sql: { description: 'T-SQL, such as SELECT TOP 10 * FROM users. Several statements return several results.' } },
  async run(input, running) {
    const { host, port, database } = parseAddress(running.address)
    // Sosie's endpoint takes any login; its certificate is its own CA's, on this machine.
    const client = await Upstream.open({ host, port, database, user: 'sosie_mcp', password: 'sosie', encrypt: 'on', verify: false, readOnlyIntent: false })
    try {
      const reply = await client.request(PACKET.BATCH, Buffer.concat([allHeaders(), Buffer.from(input.sql ?? '', 'utf16le')]))
      const results: { rows: Record<string, unknown>[]; rowCount: number; note?: string }[] = []
      const notes: string[] = []
      const errors: string[] = []
      let columns: Column[] = []
      let rows: Record<string, unknown>[] | undefined
      let count = 0
      const close = () => {
        if (!rows) return
        results.push({ rows, rowCount: count, ...(count > MAX_ROWS && { note: `Only the first ${MAX_ROWS} of ${count} rows are shown. Narrow the query.` }) })
        rows = undefined
      }
      for (const t of readTokens(reply.payload)) {
        if (t.kind === 'colmetadata') {
          close()
          if (t.columns) columns = t.columns
          rows = []
          count = 0
        } else if (t.kind === 'row' && rows) {
          count++
          if (rows.length < MAX_ROWS) rows.push(Object.fromEntries(columns.map((c, i) => [c.name || `column${i + 1}`, shown(c, t.values[i]!.bytes)])))
        } else if (t.kind === 'done') close()
        else if (t.kind === 'message') (t.error ? errors : notes).push(t.text)
      }
      close()
      if (errors.length && !results.length) throw new Error(errors.join('\n'))
      const extra = { ...(notes.length && { notes }), ...(errors.length && { errors }) }
      return results.length === 1 ? { ...results[0], ...extra } : { results, ...extra }
    } finally {
      client.close()
    }
  },
}

/** A value as JSON shows it: a whole number or a bit as a number, anything else as its text; bytes as hex. */
function shown(column: Column, bytes: Buffer | null): unknown {
  if (bytes === null) return null
  const text = textOf(column.type, bytes)
  if (text === undefined) return null
  const id = column.type.id
  if ([TYPE.INT1, TYPE.INT2, TYPE.INT4, TYPE.INTN, TYPE.BIT, TYPE.BITN].includes(id as never)) return Number(text)
  if (text.startsWith('\\x')) return `0x${text.slice(2)}`
  return text
}
