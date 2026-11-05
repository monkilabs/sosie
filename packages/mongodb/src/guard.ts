import type { Document } from 'bson'

/** Why Sosie does not run a command, as MongoDB says it: code 13, Unauthorized, which no driver retries. */
export interface Refusal {
  code: number
  codeName: string
  errmsg: string
}

const refusal = (errmsg: string): Refusal => ({ code: 13, codeName: 'Unauthorized', errmsg })

export const WRITE = refusal('This command changes data. Sosie is read-only.')

/** What Sosie does with a command. */
export type Plan =
  /** Answered by Sosie itself: the handshake, and what it would show of the upstream otherwise. */
  | { kind: 'local' }
  /** Run upstream, its answer read for values. */
  | { kind: 'read'; command: string }
  | { kind: 'refused'; refusal: Refusal }

/** Commands that read: each run upstream, and every value it returns faked. */
const READS = new Set(['find', 'aggregate', 'getMore', 'count', 'distinct', 'killCursors'])

/** Commands that show the schema, sizes or nothing of a document: run upstream, their answers as they are. */
const SCHEMA = new Set(['listCollections', 'listIndexes', 'listDatabases', 'dbStats', 'listSearchIndexes'])

/** Answered by Sosie: the handshake, sessions, and what Sosie says of itself in place of the upstream's. */
const LOCAL = new Set([
  'hello', 'isMaster', 'ismaster', 'ping', 'buildInfo', 'buildinfo', 'endSessions', 'whatsmyuri', 'connectionStatus',
  'getLog', 'getParameter', 'refreshSessions', 'startSession', 'hostInfo', 'getCmdLineOpts', 'serverStatus', 'atlasVersion',
  'getFreeMonitoringStatus', 'saslStart', 'saslContinue', 'authenticate', 'logout', 'getnonce',
])

/** Commands that write, or change the server, by MongoDB's names. */
const WRITES = new Set([
  'insert', 'update', 'delete', 'findAndModify', 'findandmodify', 'bulkWrite', 'create', 'drop', 'dropDatabase',
  'createIndexes', 'dropIndexes', 'renameCollection', 'collMod', 'convertToCapped', 'cloneCollectionAsCapped', 'compact',
  'reIndex', 'createUser', 'updateUser', 'dropUser', 'dropAllUsersFromDatabase', 'grantRolesToUser', 'revokeRolesFromUser',
  'createRole', 'updateRole', 'dropRole', 'applyOps', 'mapReduce', 'mapreduce', 'shutdown', 'fsync', 'setParameter',
  'setFeatureCompatibilityVersion', 'createSearchIndexes', 'updateSearchIndex', 'dropSearchIndex', 'commitTransaction',
  'abortTransaction', 'killOp', 'killAllSessions', 'killSessions', 'cleanupOrphaned', 'validate',
])

/** Databases MongoDB keeps for itself: users and their password hashes (admin), every write with its values (local's oplog), sessions and shard bounds (config). */
const SYSTEM_DATABASES: Record<string, string> = {
  admin: 'holds the users and their password hashes',
  local: 'holds the oplog, every write with its values',
  config: 'holds sessions, and the values that bound each shard',
}

/** Collections that hold queries with their values, or code. */
const SYSTEM_COLLECTIONS: Record<string, string> = {
  'system.profile': 'holds queries with the real values in them',
  'system.js': 'holds code that runs on the server',
  'system.users': 'holds users and their password hashes',
}

/** Stages that write, show other sessions' queries, or what the server is: refused. */
const REFUSED_STAGES: Record<string, string> = {
  $out: 'writes its results to a collection',
  $merge: 'writes its results to a collection',
  $currentOp: 'shows the operations running, with their values',
  $listSessions: 'shows the sessions of every user',
  $listLocalSessions: 'shows the sessions of every user',
  $planCacheStats: 'shows queries with their values',
  $changeStream: 'streams every change, with its values, as long as it runs',
  $changeStreamSplitLargeEvent: 'streams every change',
  $collStats: 'shows where the server is',
  $indexStats: 'shows where the server is',
  $querySettings: 'shows the settings of queries, with their values',
  $listClusterCatalog: 'shows the server’s catalog',
}

/** Stages Sosie knows the shape of their documents. */
const STAGES = new Set([
  '$match', '$sort', '$limit', '$skip', '$sample', '$redact', '$unset', '$search', '$searchMeta', '$vectorSearch', '$unwind',
  '$project', '$addFields', '$set', '$replaceRoot', '$replaceWith', '$group', '$count', '$sortByCount', '$bucket',
  '$bucketAuto', '$facet', '$lookup', '$graphLookup', '$unionWith', '$geoNear', '$setWindowFields', '$densify', '$fill',
  '$documents', '$listSearchIndexes',
])

/** Operators that run JavaScript on the server, over the documents: what they compute cannot be read. */
const JAVASCRIPT = new Set(['$where', '$function', '$accumulator'])

/** What a command is, and whether Sosie runs it. */
export function plan(body: Document): Plan {
  const name = commandName(body)
  if (!name) return { kind: 'refused', refusal: refusal('A command with no name.') }
  if (body.startTransaction || body.autocommit !== undefined) return { kind: 'refused', refusal: refusal('Sosie does not run transactions: read without one.') }
  if (LOCAL.has(name)) return { kind: 'local' }
  if (WRITES.has(name)) return { kind: 'refused', refusal: WRITE }
  if (typeof body.$db !== 'string' || !body.$db) return { kind: 'refused', refusal: refusal(`${name} names no database: OP_MSG carries it in $db.`) }
  if (name === 'explain') return { kind: 'refused', refusal: refusal('Sosie does not run explain: a plan shows the real values Sosie puts in your query.') }
  const db = String(body.$db ?? '')
  if (db in SYSTEM_DATABASES && name !== 'listDatabases' && !(name === 'killCursors')) {
    return { kind: 'refused', refusal: refusal(`Sosie does not read the ${db} database: it ${SYSTEM_DATABASES[db]}.`) }
  }
  const target = typeof body[name] === 'string' ? (body[name] as string) : undefined
  const system = target && SYSTEM_COLLECTIONS[target]
  if (system) return { kind: 'refused', refusal: refusal(`Sosie does not read ${target}: it ${system}.`) }
  if (READS.has(name) || SCHEMA.has(name)) {
    const problem = check(body, name)
    return problem ? { kind: 'refused', refusal: problem } : { kind: 'read', command: name }
  }
  return { kind: 'refused', refusal: refusal(`Sosie does not run ${name}: it reads with find, aggregate, count and distinct.`) }
}

export function commandName(body: Document): string | undefined {
  return Object.keys(body)[0]
}

/** What in a read Sosie does not run: a stage that writes or shows other sessions, server-side JavaScript. */
function check(body: Document, name: string): Refusal | undefined {
  // A command's let defines variables its filter or pipeline reads ($$name): JavaScript there runs as anywhere else.
  const found = javascript([body.filter, body.query, body.projection, body.let])
  if (found) return refusal(`Sosie does not run ${found}: JavaScript on the server computes what Sosie cannot read.`)
  if (name === 'aggregate') {
    if (!Array.isArray(body.pipeline)) return refusal('An aggregate needs a pipeline.')
    return stages(body.pipeline as Document[])
  }
  if (name === 'listCollections' || name === 'listIndexes') return undefined
  return undefined
}

/** A pipeline's stages, a $facet's, a $lookup's and a $unionWith's included. */
function stages(pipeline: Document[]): Refusal | undefined {
  for (const stage of pipeline) {
    const [name] = Object.keys(stage ?? {})
    if (!name) return refusal('A stage with no name.')
    const reason = REFUSED_STAGES[name]
    if (reason) return refusal(`Sosie does not run ${name}: it ${reason}.`)
    if (!STAGES.has(name)) return refusal(`Sosie does not run ${name}: a stage it does not know the shape of.`)
    const found = javascript(stage)
    if (found) return refusal(`Sosie does not run ${found}: JavaScript on the server computes what Sosie cannot read.`)
    const spec = stage[name] as Document
    const nested: Document[][] =
      name === '$facet'
        ? (Object.values(spec ?? {}) as Document[][])
        : (name === '$lookup' || name === '$unionWith') && Array.isArray(spec?.pipeline)
          ? [spec.pipeline as Document[]]
          : []
    for (const sub of nested) {
      const problem = stages(sub)
      if (problem) return problem
    }
    const from = name === '$lookup' || name === '$graphLookup' ? spec?.from : name === '$unionWith' ? (typeof spec === 'string' ? spec : spec?.coll) : undefined
    if (typeof from === 'string' && SYSTEM_COLLECTIONS[from]) return refusal(`Sosie does not read ${from}: it ${SYSTEM_COLLECTIONS[from]}.`)
    if (from && typeof from === 'object' && (from as Document).db in SYSTEM_DATABASES) {
      return refusal(`Sosie does not read the ${(from as Document).db} database: it ${SYSTEM_DATABASES[(from as Document).db]}.`)
    }
  }
  return undefined
}

/** The first operator that runs JavaScript, anywhere in what is given. */
function javascript(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = javascript(item)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object' || '_bsontype' in node || node instanceof Date) {
    // Code, as BSON carries it, is JavaScript too.
    if (node && typeof node === 'object' && '_bsontype' in node && (node as { _bsontype: string })._bsontype === 'Code') return 'JavaScript code'
    return undefined
  }
  for (const [key, value] of Object.entries(node)) {
    if (JAVASCRIPT.has(key)) return key
    const found = javascript(value)
    if (found) return found
  }
  return undefined
}
