import type { RequestScope } from '@sosie/core'
import type { Document } from 'bson'
import type { UpstreamError } from './upstream.js'

/**
 * Errors whose messages are about the command and the schema: shown, scrubbed of what Sosie turned back. MongoDB's
 * other errors may quote a value from a document (a conversion's input, a key that is a duplicate), and are shown
 * by their code only.
 */
const ABOUT_THE_COMMAND = new Set([
  2, // BadValue: an operator or an option the server does not take
  9, // FailedToParse
  13, // Unauthorized: the login may not read it
  14, // TypeMismatch
  26, // NamespaceNotFound
  40, // ConflictingUpdateOperators
  43, // CursorNotFound
  50, // MaxTimeMSExpired: the time limit
  59, // CommandNotFound
  72, // InvalidOptions
  73, // InvalidNamespace
  115, // CommandNotSupported
  166, // CommandNotSupportedOnView
  168, // InvalidPipelineOperator
  40324, // An unrecognized pipeline stage
  40415, // An unknown field in a stage
  17276, // Use of undefined variable
  15983, // An expression with too many fields
  16410, // A field name starting with $
  16436, // A stage's name
  31249, // A path collision in a projection
  31250, // A path collision in a projection
  31254, // An exclusion in an inclusion projection
  51024, // A command's argument
])

/** An error answer for the client: shown when it is about the command, scrubbed; by its code otherwise. */
export function errorAnswer(error: UpstreamError, scope: RequestScope | undefined): Document {
  const errmsg = ABOUT_THE_COMMAND.has(error.code)
    ? (scope?.scrub(error.errmsg) ?? error.errmsg)
    : `Error ${error.code} (${error.codeName}): Sosie hides the rest of this message, which may quote a value from your documents.`
  return { ok: 0, errmsg, code: error.code, codeName: error.codeName }
}

/** An error of Sosie's own. */
export function sosieError(code: number, codeName: string, errmsg: string): Document {
  return { ok: 0, errmsg, code, codeName }
}
