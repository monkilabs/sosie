import type { Source } from '@sosie/core'
import { graphql } from '@sosie/graphql'
import { postgres } from '@sosie/postgres'
import { rest } from '@sosie/rest'

/** The sources this CLI knows, asked in order whether they handle an upstream: GraphQL before REST, which takes any other http(s) URL. */
export const sources: Source[] = [postgres, graphql, rest]
