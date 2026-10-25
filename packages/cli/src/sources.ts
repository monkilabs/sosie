import type { Source } from '@sosie/core'
import { postgres } from '@sosie/postgres'

/** The sources this CLI knows, asked in order whether they handle an upstream. */
export const sources: Source[] = [postgres]
