import type { Source } from '@sosie/core'
import { postgres } from '@sosie/postgres'
import { rest } from '@sosie/rest'

/** The sources this CLI knows, asked in order whether they handle an upstream. */
export const sources: Source[] = [postgres, rest]
