/**
 * The thread that checks queries against the schema and answers
 * introspection: graphql-js does each in one go, and a small query can ask
 * for seconds of checking or gigabytes of answer. Here, the endpoint's
 * thread goes on answering other clients, and stops this one when it takes
 * too long.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { buildClientSchema, execute, parse, validate, type IntrospectionQuery } from 'graphql'

export type CheckJob =
  | { id: number; kind: 'validate'; query: string }
  | { id: number; kind: 'introspect'; query: string; operationName: string | undefined; variables: Record<string, unknown> }

export type CheckAnswer =
  | { id: number; errors: { message: string; locations?: readonly { line: number; column: number }[] }[] }
  | { id: number; text: string }
  | { id: number; refused: string }

const { introspection, maxTokens, maxAnswer } = workerData as { introspection: IntrospectionQuery; maxTokens: number; maxAnswer: number }
const schema = buildClientSchema(introspection)

parentPort!.on('message', async (job: CheckJob) => {
  try {
    parentPort!.postMessage(await answer(job))
  } catch (error) {
    // The endpoint parsed the same text first, so this is graphql-js failing: the message names no value of the data.
    parentPort!.postMessage({ id: job.id, refused: (error as Error).message })
  }
})

async function answer(job: CheckJob): Promise<CheckAnswer> {
  const document = parse(job.query, { maxTokens })
  if (job.kind === 'validate') {
    // Errors of the request against the schema hold only what the client wrote, and the schema.
    const errors = validate(schema, document).map((e) => ({ message: e.message, ...(e.locations && { locations: e.locations }) }))
    return { id: job.id, errors }
  }
  const text = JSON.stringify(await execute({ schema, document, operationName: job.operationName, variableValues: job.variables }))
  if (text.length > maxAnswer) return { id: job.id, refused: `The answer is larger than ${maxAnswer / 1024 / 1024} MB: ask for less of the schema at once.` }
  return { id: job.id, text }
}
