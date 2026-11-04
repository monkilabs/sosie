import mysql from 'mysql2'
import type { Column } from './protocol.js'

export interface UpstreamOptions {
  statementTimeout: number
  maxRows: number
}

/** Modes that change how MySQL reads a statement's text: Sosie's parser reads it as MySQL does without them. */
const LEXICAL_MODES = new Set(['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES', 'PIPES_AS_CONCAT', 'ANSI'])

/** mysql2's options from the connection string: TLS when it asks for it, never a password in an argument. */
export function config(upstream: URL): mysql.ConnectionOptions {
  const mode = (upstream.searchParams.get('ssl-mode') ?? upstream.searchParams.get('sslmode') ?? '').toUpperCase()
  const ssl = upstream.searchParams.get('ssl')
  return {
    host: decodeURIComponent(upstream.hostname) || 'localhost',
    port: Number(upstream.port || 3306),
    user: decodeURIComponent(upstream.username),
    password: decodeURIComponent(upstream.password),
    database: decodeURIComponent(upstream.pathname.slice(1)) || undefined,
    charset: 'utf8mb4',
    connectTimeout: 10_000,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    ...(mode && mode !== 'DISABLED' && mode !== 'PREFERRED'
      ? { ssl: { rejectUnauthorized: mode === 'VERIFY_CA' || mode === 'VERIFY_IDENTITY' } }
      : ssl === 'true'
        ? { ssl: { rejectUnauthorized: true } }
        : {}),
  }
}

/** What a statement returned: its columns and rows, each value as the server's text bytes; or an OK. */
export interface Result {
  columns?: Column[]
  rows?: (Buffer | null)[][]
  /** Rows past the cap were read and dropped. */
  capped?: boolean
  affected?: number
  warnings: number
  info?: string
}

export interface UpstreamError {
  code: number
  sqlState: string
  message: string
  /** The server had started on the rows when it failed: its message may quote a value. */
  reading: boolean
}

/** One read-only session upstream, per client. */
export class Upstream {
  version = ''

  private constructor(
    private readonly connection: mysql.Connection,
    private readonly options: UpstreamOptions,
  ) {}

  static async open(upstream: URL, options: UpstreamOptions): Promise<Upstream> {
    const connection = mysql.createConnection(config(upstream))
    connection.on('error', () => {})
    await new Promise<void>((resolve, reject) => connection.connect((error) => (error ? reject(error) : resolve())))
    const session = new Upstream(connection, options)
    const [row] = (await session.plain('SELECT VERSION() AS v, @@SESSION.sql_mode AS mode')) as { v: string; mode: string }[]
    const modes = String(row?.mode ?? '')
      .split(',')
      .filter((m) => m && !LEXICAL_MODES.has(m.toUpperCase()))
    for (const statement of [
      `SET SESSION sql_mode = ${connection.escape(modes.join(','))}`,
      'SET SESSION transaction_read_only = ON',
      `SET SESSION max_execution_time = ${Math.floor(options.statementTimeout)}`,
      // A SELECT without a LIMIT stops one row past the cap; with one, Sosie reads and drops the rest.
      `SET SESSION sql_select_limit = ${options.maxRows + 1}`,
    ]) {
      await session.plain(statement)
    }
    session.version = String(row?.v ?? '')
    return session
  }

  /** A query with mysql2's own values: only for Sosie's own statements. */
  plain(sql: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => this.connection.query(sql, (error, rows) => (error ? reject(error) : resolve(rows as unknown[]))))
  }

  /** Run a statement the guard allowed, its rows as text bytes, at most the cap of them. */
  run(sql: string): Promise<Result> {
    return new Promise((resolve, reject) => {
      const result: Result = { warnings: 0 }
      let failed = false
      this.connection
        .query({ sql, rowsAsArray: true, typeCast: false })
        .on('fields', (fields: mysql.FieldPacket[] | undefined) => {
          // mysql2 says fields for a statement that has none too, as undefined: an OK follows.
          if (!fields) return
          result.columns = fields.map(column)
          result.rows = []
        })
        .on('result', (row: unknown) => {
          if (Array.isArray(row)) {
            if (result.rows!.length < this.options.maxRows) result.rows!.push(row as (Buffer | null)[])
            else result.capped = true
          } else {
            const header = row as mysql.ResultSetHeader
            result.affected = header.affectedRows
            result.warnings = header.warningStatus ?? 0
            result.info = header.info
          }
        })
        .on('error', (error: mysql.QueryError & { sqlState?: string; errno?: number; fatal?: boolean }) => {
          failed = true
          if (error.fatal) return reject(error)
          reject({
            code: error.errno ?? 1105,
            sqlState: error.sqlState ?? 'HY000',
            message: error.message,
            reading: result.columns !== undefined,
          } satisfies UpstreamError)
        })
        .on('end', () => {
          if (!failed) resolve(result)
        })
    })
  }

  async end(): Promise<void> {
    await new Promise<void>((resolve) => this.connection.end(() => resolve()))
  }
}

function column(f: mysql.FieldPacket): Column {
  const field = f as mysql.FieldPacket & { columnLength?: number; characterSet?: number; orgName?: string; orgTable?: string }
  return {
    schema: field.schema ?? '',
    table: field.table ?? '',
    orgTable: field.orgTable ?? '',
    name: field.name,
    orgName: field.orgName ?? '',
    characterSet: field.characterSet ?? 33,
    length: field.columnLength ?? field.length ?? 0,
    type: field.columnType ?? field.type ?? 253,
    flags: Number(field.flags ?? 0),
    decimals: field.decimals ?? 0,
  }
}
