/**
 * The contract between the core and a source. A source knows one kind of
 * upstream (Postgres now; REST, GraphQL and other databases later): it
 * describes the upstream in the neutral schema, serves an endpoint, and hands
 * every value it returns to the core's Faker. The core never sees a protocol.
 */

/** A value as a source hands it over: text, null, or a list of values. */
export type Value = string | null | Value[]

export interface Schema {
  entities: Entity[]
}

export interface Entity {
  /** 'users', or 'billing.invoices' outside the default namespace. */
  id: string
  name: string
  fields: Field[]
}

export interface Field {
  /** 'users.email': the name rules use. */
  id: string
  /** 'email': picks a realistic format. */
  name: string
  type: FieldType
  key?: 'primary' | 'unique'
  /** The id of the field whose values this one shares: a foreign key's target, or a view column's source. */
  references?: string
}

export type FieldType =
  | { kind: 'string'; maxLength?: number }
  | { kind: 'integer'; bytes?: 2 | 4 | 8 }
  | { kind: 'decimal' }
  | { kind: 'boolean' }
  | { kind: 'enum'; labels: string[] }
  | { kind: 'date' | 'datetime' | 'time' }
  | { kind: 'uuid' | 'bytes' | 'ip' }
  | { kind: 'json' }
  | { kind: 'array'; of: FieldType }
  | { kind: 'unknown' }

export interface Faker {
  /** The fake of a value read from a field. Null stays null; a field that passes returns the value unchanged. */
  value(value: Value, field: Field): Value
  /**
   * The fake of a value no field holds, such as length(email) or upper(name).
   * `sent` is what the client sent: a JSON key it wrote is structure, not a value.
   */
  computed(value: Value, type: FieldType, sent?: string): Value
  /** Whether a field's values pass unchanged. */
  passes(field: Field): boolean
  /**
   * A scope per request, so its errors can be scrubbed of what it substituted.
   * `sent` is what the client sent; `from` is an earlier scope of the same
   * request, such as a prepared statement's, whose substitutions carry over.
   */
  request(sent?: string, from?: RequestScope): RequestScope
}

export interface RequestScope {
  /**
   * The real value behind a fake the client sent. With `near`, the field the
   * client compared it with, the fake is looked up in that field's domain;
   * without it, a fake that names exactly one real value is used. Undefined
   * leaves the value as written.
   */
  lookup(fake: string, near?: Field): string | undefined
  /** Text with every real value this request substituted turned back into its fake, and anything quoted the client did not send masked. */
  scrub(text: string): string
}

export interface SourceOptions {
  /** Rows a query returns at most. */
  maxRows: number
  /** Milliseconds a statement may run upstream. */
  statementTimeout: number
}

export interface Source {
  /** 'postgres' now; 'rest', 'graphql', 'mysql' later. */
  readonly kind: string
  /** Whether this source handles this upstream, or this endpoint address. */
  matches(url: URL): boolean
  /** Connect read-only and describe the upstream in neutral terms. */
  connect(upstream: URL, options: SourceOptions): Promise<Connection>
  /** MCP tools this source adds beside the core's describe: Postgres adds query. They talk to the running endpoint, never to the upstream. */
  readonly tools?: McpTool[]
}

export interface Connection {
  readonly schema: Schema
  /** Where the upstream is, without credentials: 'db.internal:5432/app'. Shown in the terminal. */
  readonly label: string
  /** What was found, for the terminal: '42 tables'. */
  readonly summary: string
  /** Things the developer should know, for the terminal. */
  readonly warnings: string[]
  /** Start the endpoint clients use. Every value it returns goes through the Faker. */
  serve(listen: { host: string; port: number }, faker: Faker): Promise<Endpoint>
  close(): Promise<void>
}

export interface Endpoint {
  /** What clients use: postgres://localhost:7674/app. */
  readonly address: string
  close(): Promise<void>
}

/** What `sosie mcp` knows about the running endpoint. */
export interface Running {
  kind: string
  address: string
  schema: Schema
  /** Ids of the fields whose values pass unchanged. */
  passing: string[]
}

export interface McpTool {
  name: string
  description: string
  /** Each input is a string. */
  input: Record<string, { description: string; optional?: boolean }>
  run(input: Record<string, string | undefined>, running: Running): Promise<unknown>
}
