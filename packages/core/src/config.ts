import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { parse } from 'yaml'
import { suggest, yamlProblem, type RuleSet } from './rules.js'

/**
 * sosie.yml: the project's sources, and how their values are faked. The only configuration there is. Settings at the
 * top hold for every source, and a source may set its own; credentials are never written in it, only the names of
 * the variables that hold them.
 */
export interface Config {
  file: string
  /** The top's rules, for every source. */
  rules: RuleSet
  sources: SourceConfig[]
}

export interface SourceConfig {
  name: string
  /** The variable that holds the upstream, for `upstream: ${SHOP_URL}`: SHOP_URL. */
  upstream: string
  kind?: string
  /** An absolute path, or a URL. */
  schema?: string
  /** Each header as written, its ${NAME}s not read yet. */
  headers: Record<string, string>
  port?: number
  host: string
  maxRows: number
  /** Seconds. */
  timeout: number
  /** The source's own rules. */
  rules: RuleSet
}

/** A kind of source the CLI knows, and the keys it takes beyond every source's. */
export interface Kind {
  kind: string
  settings?: readonly string[]
}

export class ConfigError extends Error {
  /** `unwritten`: sosie.yml has no sources key and nothing else wrong, so its first source is still to be written. */
  constructor(
    readonly problems: string[],
    readonly unwritten = false,
  ) {
    super(problems.join('\n'))
    this.name = 'ConfigError'
  }
}

export const DEFAULTS = { host: '127.0.0.1', maxRows: 1000, timeout: 30 } as const

/** What a sosie.yml with no sources key is told: the one problem sosie init mends. */
export const noSourcesProblem = (file = 'sosie.yml') => `${file} names no sources. Add one under sources:, or run sosie init.`

const TOP = ['sources', 'pass', 'format', 'host', 'max-rows', 'timeout']
const SOURCE = ['upstream', 'kind', 'schema', 'headers', 'port', 'host', 'max-rows', 'timeout', 'pass', 'format']
const NAME = /^[a-z][a-z0-9_-]{0,39}$/
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
/** A header's $$, a $ of its text, or a ${NAME}: read from the left, so $${NAME} is text and asks for nothing. */
const TEMPLATE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const WHOLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/** The variable a source's upstream would be kept in, by its name: shop, SHOP_URL. */
export const variableFor = (name: string) => `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`

/** Whether a name may name a source: lowercase letters, digits, - and _, a letter first. */
export const isSourceName = (name: string) => NAME.test(name)

/** The names of sosie.yml's sources; undefined when it has no `sources` key, so that one can be added. */
export function sourceNames(text: string, file = 'sosie.yml'): string[] | undefined {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (error) {
    throw new ConfigError([yamlProblem(file, error)])
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !('sources' in doc)) return undefined
  const sources = (doc as { sources: unknown }).sources
  return sources && typeof sources === 'object' && !Array.isArray(sources) ? Object.keys(sources) : []
}

/** Read and check sosie.yml's text: every problem at once, each naming where it is. `location` is the file's, for its schemas. */
export function readConfig(text: string, location: string, kinds: Kind[]): Config {
  const file = basename(location)
  const problems: string[] = []
  const at = (path: string, what: string) => problems.push(`${file}: ${path}${what}`)
  let doc: unknown
  // Every value as its text, for headers: 1.0, 0x1F and true are sent as written, never as YAML reads them.
  let written: unknown
  try {
    doc = parse(text)
    written = parse(text, { schema: 'failsafe' })
  } catch (error) {
    throw new ConfigError([yamlProblem(file, error)])
  }
  if (doc == null) doc = {}
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError([`${file}: expected keys such as sources, pass and format.`])
  const top = doc as Record<string, unknown>
  const textOf = (name: string, header: string): unknown =>
    (written as { sources?: Record<string, { headers?: Record<string, unknown> }> } | null)?.sources?.[name]?.headers?.[header]

  for (const key of Object.keys(top)) {
    if (TOP.includes(key)) continue
    const hint = suggest(key, TOP)
    at(key, ` is not a key.${hint ? ` Did you mean ${hint}?` : ''} Keys: ${TOP.join(', ')}.`)
  }
  noVariables(top, '', TOP, ['sources'], at)
  const shared = settings(top, '', at)

  const sources: SourceConfig[] = []
  const given = top.sources
  if (!('sources' in top)) {
    problems.push(noSourcesProblem(file))
  } else if (given === null || (typeof given === 'object' && !Array.isArray(given) && !Object.keys(given).length)) {
    // As sosie init says: it writes no second sources key.
    problems.push(`${file} has a sources: key with none under it. Add one there, such as shop: { upstream: \${SHOP_URL} }.`)
  } else if (typeof given !== 'object' || Array.isArray(given)) {
    at('sources', ' maps each source by its name to its settings, such as shop: { upstream: ${SHOP_URL} }.')
  } else {
    const ports = new Map<number, string>()
    for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
      const path = `sources.${name}`
      if (!NAME.test(name)) {
        at(path, ': a source is named in lowercase letters, digits, - and _, a letter first.')
        continue
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        at(path, ` holds its settings, at least its upstream: ${name}: { upstream: \${${variableFor(name)}} }.`)
        continue
      }
      const source = value as Record<string, unknown>
      for (const key of Object.keys(source)) {
        if (SOURCE.includes(key)) continue
        const hint = suggest(key, SOURCE)
        at(`${path}.${key}`, ` is not a key of a source.${hint ? ` Did you mean ${hint}?` : ''} Keys: ${SOURCE.join(', ')}.`)
      }
      noVariables(source, `${path}.`, SOURCE, ['upstream', 'headers'], at)

      // The upstream: one whole variable. A URL written out, even in part, could send a credential to a host an
      // edit chose, so it is refused, and never quoted: it may hold the credential.
      let upstream = ''
      const written = source.upstream
      const whole = typeof written === 'string' ? WHOLE.exec(written) : null
      if (whole) upstream = whole[1]!
      else if (written === undefined) at(`${path}`, ` has no upstream: upstream: \${${variableFor(name)}}, the variable that holds its connection string.`)
      else {
        at(
          `${path}.upstream`,
          ` is one variable, such as \${${variableFor(name)}}, set in the terminal Sosie starts in: an upstream is never written in sosie.yml, not even in part.`,
        )
      }

      let kind: string | undefined
      if (source.kind !== undefined) {
        const names = kinds.map((k) => k.kind)
        if (typeof source.kind === 'string' && names.includes(source.kind)) kind = source.kind
        else {
          const hint = typeof source.kind === 'string' ? suggest(source.kind, names) : undefined
          at(`${path}.kind`, ` is one of ${names.join(', ')}.${hint ? ` Did you mean ${hint}?` : ''}`)
        }
      }

      let schema: string | undefined
      if (source.schema !== undefined) {
        if (typeof source.schema !== 'string' || !source.schema.trim()) at(`${path}.schema`, ' is a file, by its path from sosie.yml, or a URL.')
        else schema = /^https?:\/\//i.test(source.schema) || isAbsolute(source.schema) ? source.schema : resolve(dirname(location), source.schema)
      }

      const headers: Record<string, string> = {}
      if (source.headers !== undefined) {
        if (!source.headers || typeof source.headers !== 'object' || Array.isArray(source.headers)) {
          at(`${path}.headers`, ' maps each header to its value, such as Authorization: Bearer ${TOKEN}.')
        } else {
          for (const header of Object.keys(source.headers as Record<string, unknown>)) {
            const v = textOf(name, header)
            if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) at(`${path}.headers`, ': a header is named in letters, digits and dashes.')
            else if (typeof v !== 'string') at(`${path}.headers.${header}`, ' is a value on one line.')
            else if (!v) at(`${path}.headers.${header}`, ' has no value.')
            else {
              const template = v
              const unclosed = template.replace(/\$\$/g, '').replace(VARIABLE, '').includes('${')
              if (unclosed) at(`${path}.headers.${header}`, ' names a variable as ${NAME}: letters, digits and _.')
              else headers[header] = template
            }
          }
        }
      }

      let port: number | undefined
      if (source.port !== undefined) {
        if (!Number.isInteger(source.port) || (source.port as number) < 0 || (source.port as number) > 65_535) {
          at(`${path}.port`, ` is a whole number from 0 to 65535, not ${String(source.port)}.`)
        } else {
          port = source.port as number
          const other = ports.get(port)
          if (other && port !== 0) at(`${path}.port`, `: ${port} is ${other}'s port too.`)
          ports.set(port, name)
        }
      }

      const own = settings(source, `${path}.`, at)
      const known = kind ? kinds.find((k) => k.kind === kind) : undefined
      if (known) problems.push(...settingsProblems({ name, headers, ...(schema && { schema }) }, known, file))
      sources.push({
        name,
        upstream,
        ...(kind && { kind }),
        ...(schema && { schema }),
        headers,
        ...(port !== undefined && { port }),
        host: own.host ?? shared.host ?? DEFAULTS.host,
        maxRows: own.maxRows ?? shared.maxRows ?? DEFAULTS.maxRows,
        timeout: own.timeout ?? shared.timeout ?? DEFAULTS.timeout,
        rules: { ...(source.pass !== undefined && { pass: source.pass }), ...(source.format !== undefined && { format: source.format }) },
      })
    }
  }

  if (problems.length) throw new ConfigError(problems, !('sources' in top) && problems.length === 1)
  return {
    file,
    rules: { ...(top.pass !== undefined && { pass: top.pass }), ...(top.format !== undefined && { format: top.format }) },
    sources,
  }
}

/** A key a source's kind does not take: told by its name, and why. */
export function settingsProblems(source: Pick<SourceConfig, 'name' | 'headers' | 'schema'>, kind: Kind, file = 'sosie.yml'): string[] {
  const takes = new Set(kind.settings ?? [])
  const problems: string[] = []
  if (Object.keys(source.headers).length && !takes.has('headers')) {
    problems.push(`${file}: sources.${source.name}.headers: ${source.name} is a ${kind.kind} source, which takes no headers.`)
  }
  if (source.schema !== undefined && !takes.has('schema')) {
    problems.push(`${file}: sources.${source.name}.schema: ${source.name} is a ${kind.kind} source, which takes no schema.`)
  }
  return problems
}

/** Every variable the sources name, in the order they are named, each once. */
export function variablesOf(config: Config): string[] {
  const names = new Set<string>()
  for (const source of config.sources) {
    if (source.upstream) names.add(source.upstream)
    for (const template of Object.values(source.headers)) for (const [, name] of template.matchAll(TEMPLATE)) if (name) names.add(name)
  }
  return [...names]
}

/** A header's value, its ${NAME}s read from `values` and each $$ a $. */
export function interpolate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(TEMPLATE, (match, name: string | undefined) => (name ? (values[name] ?? '') : '$'))
}

/** host, max-rows and timeout, at the top or in a source, each checked. */
function settings(from: Record<string, unknown>, path: string, at: (path: string, what: string) => void) {
  const out: { host?: string; maxRows?: number; timeout?: number } = {}
  if (from.host !== undefined) {
    if (typeof from.host !== 'string' || !from.host.trim()) at(`${path}host`, ' is an address to listen on, such as 127.0.0.1.')
    else out.host = from.host
  }
  const whole = (key: string, min: number, max?: number) => {
    const value = from[key]
    if (value === undefined) return undefined
    if (!Number.isInteger(value) || (value as number) < min || (max !== undefined && (value as number) > max)) {
      at(`${path}${key}`, ` is a whole number ${max === undefined ? `from ${min}` : `from ${min} to ${max}`}, not ${String(value)}.`)
      return undefined
    }
    return value as number
  }
  const maxRows = whole('max-rows', 1)
  if (maxRows !== undefined) out.maxRows = maxRows
  const timeout = whole('timeout', 1, 3600)
  if (timeout !== undefined) out.timeout = timeout
  return out
}

/** Only upstream and headers read variables: a ${ anywhere else is told, so none reads one by surprise. */
function noVariables(from: Record<string, unknown>, path: string, keys: string[], except: string[], at: (path: string, what: string) => void) {
  for (const [key, value] of Object.entries(from)) {
    // A key that is none is told as such already.
    if (!keys.includes(key) || except.includes(key)) continue
    if (JSON.stringify(value ?? null).includes('${')) at(`${path}${key}`, ' reads no variable: only upstream and headers do.')
  }
}
