import type { McpTool, Running } from '@sosie/core'
import { EJSON, Long, type Document } from 'bson'
import { MongoClient } from 'mongodb'

const MAX_DOCUMENTS = 200

const NOTE =
  'Every value is a consistent fake: the same real value is always the same fake, so references between collections ' +
  'hold, and a value you saw finds its document again in a filter.'

/* eslint-disable @typescript-eslint/no-explicit-any -- documents as the driver returns them. */

/** Extended JSON, as an agent writes it: { "_id": { "$oid": "…" } }, or plain JSON. */
function parse(text: string | undefined, what: string): any {
  if (!text?.trim()) return undefined
  try {
    return EJSON.parse(text, { relaxed: true })
  } catch (error) {
    throw new Error(`The ${what} is not JSON: ${(error as Error).message}`)
  }
}

/** Documents as relaxed Extended JSON, a 64-bit integer past what a JSON number holds kept whole. */
function shown(docs: Document[]): unknown {
  const keep = (v: unknown): unknown => {
    if (v instanceof Long) return Number.isSafeInteger(v.toNumber()) ? v.toNumber() : { $numberLong: v.toString() }
    if (Array.isArray(v)) return v.map(keep)
    if (v && typeof v === 'object' && !('_bsontype' in v) && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keep(x)]))
    return v
  }
  return EJSON.serialize(keep(docs), { relaxed: true })
}

async function through<T>(running: Running, work: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(running.address, { appName: 'sosie mcp', serverSelectionTimeoutMS: 5000, promoteLongs: false })
  try {
    await client.connect()
    return await work(client)
  } finally {
    await client.close().catch(() => {})
  }
}

function result(docs: Document[], more: boolean) {
  return {
    documents: shown(docs.slice(0, MAX_DOCUMENTS)),
    ...((more || docs.length > MAX_DOCUMENTS) && { note: `Only the first ${MAX_DOCUMENTS} documents are shown. Narrow the filter.` }),
  }
}

/** The MongoDB source's MCP tools: a find and an aggregation through the running endpoint, never to the upstream. */
export const findTool: McpTool = {
  name: 'find',
  description: `Find documents in a MongoDB collection through Sosie. Up to ${MAX_DOCUMENTS} come back as Extended JSON. ${NOTE}`,
  input: {
    collection: { description: 'The collection, such as users.' },
    filter: { description: 'A filter as JSON, such as {"email": "…"} or {"_id": {"$oid": "…"}}; all documents when left out.', optional: true },
    projection: { description: 'The fields to return, as JSON, such as {"email": 1}.', optional: true },
    sort: { description: 'The order, as JSON, such as {"createdAt": -1}.', optional: true },
    limit: { description: 'At most this many documents.', optional: true },
  },
  async run(input, running) {
    return through(running, async (client) => {
      const limit = Math.min(Number(input.limit) || MAX_DOCUMENTS + 1, MAX_DOCUMENTS + 1)
      const docs = await client
        .db()
        .collection(input.collection ?? '')
        .find(parse(input.filter, 'filter') ?? {}, {
          projection: parse(input.projection, 'projection'),
          sort: parse(input.sort, 'sort'),
          limit,
        })
        .toArray()
      return result(docs, false)
    })
  },
}

export const aggregateTool: McpTool = {
  name: 'aggregate',
  description: `Run an aggregation pipeline on a MongoDB collection through Sosie. Up to ${MAX_DOCUMENTS} documents come back as Extended JSON. ${NOTE}`,
  input: {
    collection: { description: 'The collection, such as orders.' },
    pipeline: { description: 'The pipeline as a JSON array, such as [{"$group": {"_id": "$status", "n": {"$sum": 1}}}].' },
  },
  async run(input, running) {
    const stages = parse(input.pipeline, 'pipeline')
    if (!Array.isArray(stages)) throw new Error('The pipeline is a JSON array of stages.')
    return through(running, async (client) => {
      const cursor = client.db().collection(input.collection ?? '').aggregate(stages)
      const docs: Document[] = []
      let more = false
      for await (const doc of cursor) {
        if (docs.length === MAX_DOCUMENTS) {
          more = true
          break
        }
        docs.push(doc)
      }
      await cursor.close()
      return result(docs, more)
    })
  },
}
