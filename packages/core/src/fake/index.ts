import { base, en, Faker as FakerJs } from '@faker-js/faker'
import { planner, type FieldPlan } from '../domains.js'
import type { Rules } from '../rules.js'
import type { Store } from '../store.js'
import type { Faker, Field, FieldType, RequestScope, Schema, Value } from '../source.js'
import { formatByName, PERSONAL, type Format } from './formats.js'
import { Random, shape } from './random.js'
import { fakeScalar, type ScalarKind } from './types.js'

const SCANNABLE = new Set<FieldType['kind']>(['string', 'integer', 'decimal', 'uuid', 'ip'])
const TRUE = /^(t|true|y|yes|on|1)$/i
const BOOLEAN = /^(t|f|true|false|y|n|yes|no|on|off|1|0)$/i
/** A key of a json column that looks like structure: a lowercase or camelCase word, perhaps ending in a number. */
const KEY_WORD = /^[a-z_]+(?:[A-Z][a-z]*)*\d{0,2}$/

/** Whether a JSON key looks like structure (city, createdAt, address_line1) rather than a value (a name, an email, a code). */
export function structuralKey(key: string): boolean {
  return KEY_WORD.test(key)
}
/** A word with a digit in it, as Postgres prints some values unquoted: 'date field value out of range: 1988-14-29'. */
const DIGITS = /[\w.:+-]*\d[\w.:+-]*/g

/** Text lowercased, its letters and digits only: Quill.Vantablack and quill_vantablack are one. */
const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
/** The words of text, lowercased: split at anything not a letter or digit, and where camelCase starts a word. */
const wordsOf = (text: string) =>
  text
    .split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase())

/** Whether text appears in what the client sent as a whole token, not inside a longer word. */
function appears(sent: string, token: string): boolean {
  const word = /\w/
  for (let at = sent.indexOf(token); at >= 0; at = sent.indexOf(token, at + 1)) {
    const before = sent[at - 1]
    const after = sent[at + token.length]
    const open = !before || !word.test(before) || !word.test(token[0]!)
    const close = !after || !word.test(after) || !word.test(token.at(-1)!)
    if (open && close) return true
  }
  return false
}

/** Texts by their first three characters, longest first: which of them starts at a place in another text. */
class Starts {
  readonly #by = new Map<string, [text: string, tag: string][]>()

  add(text: string, tag: string): void {
    const list = this.#by.get(text.slice(0, 3))
    if (list) list.push([text, tag])
    else this.#by.set(text.slice(0, 3), [[text, tag]])
  }

  /** Once every text is in: of those that start alike, the longest is tried first. */
  sorted(): this {
    for (const list of this.#by.values()) list.sort((a, b) => b[0].length - a[0].length)
    return this
  }

  /** The longest text that starts at `at` in `within`, with its tag. */
  at(within: string, at: number): [string, string] | undefined {
    return this.#by.get(within.slice(at, at + 3))?.find(([text]) => within.startsWith(text, at))
  }
}

/** A word of text, as a label is written: letters, digits, _ and -. */
const WORD = /[\p{L}\p{N}_-]+/gu

/** Whether a value a request turned back may be echoed: it has a letter, or is long. A short number may be any count. */
const counts = (real: string) => /\p{L}/u.test(real) || real.length >= 6

/** Text as a URL or a form escapes it, unescaped: %40 and + as what they stand for. */
function unescaped(text: string): string {
  if (!/[%+]/.test(text)) return text
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

/**
 * The values a request turned back, each with the fake the client sent, indexed once: a text is
 * checked for all of them in time of its own length, so a query by a thousand fakes that returns
 * a thousand rows takes thousands of steps, not a million.
 */
class Echoes {
  /** Every value, lowercased. */
  readonly #keys = new Set<string>()
  /** Values that may be echoed, lowercased, with their fakes. */
  readonly #values = new Map<string, string>()
  /** Values squashed, of three characters or more: a text's whole, or one of its words. */
  readonly #words = new Set<string>()
  readonly #counted = new Set<string>()
  /** Values squashed, of six characters or more: within a text. */
  readonly #long = new Starts()
  /** Values that may be echoed, of three characters or more, lowercased as written and as a JSON string holds them, with their fakes. */
  readonly #plain = new Starts()
  readonly #json = new Starts()

  /**
   * `labels` are enum labels and booleans the request turned back, lowercased, with their fakes: an echo
   * only as a word of text, since a field of their kind may hold the same label as its own value.
   * `secrets` are Sosie's own credentials, lowercased: never shown, in any form Sosie can tell.
   */
  constructor(
    reals: Map<string, string>,
    readonly labels: Map<string, string> = new Map(),
    readonly secrets: readonly string[] = [],
  ) {
    for (const [real, fakeValue] of reals) {
      const lower = real.toLowerCase()
      const whole = squash(real)
      this.#keys.add(lower)
      if (whole.length >= 3) this.#words.add(whole)
      if (whole.length >= 6) this.#long.add(whole, '')
      if (!counts(real)) continue
      this.#values.set(lower, fakeValue)
      if (whole.length >= 3) this.#counted.add(whole)
      if (real.length < 3) continue
      this.#plain.add(lower, fakeValue)
      this.#json.add(JSON.stringify(real).slice(1, -1).toLowerCase(), JSON.stringify(fakeValue).slice(1, -1))
    }
    this.#long.sorted()
    this.#plain.sorted()
    this.#json.sorted()
  }

  /**
   * Whether text holds a value, ignoring case and separators: the value itself, or the value among
   * the text's words (quillon_profile, quillonSettings), or within it when the value is long enough
   * to be no word's part.
   */
  holds(text: string): boolean {
    const lower = text.toLowerCase()
    return this.#keys.has(lower) || this.labels.has(lower) || this.#secret(lower) || this.#squashed(text, this.#words)
  }

  /**
   * Text with each value that may be echoed shown as its fake, whole or within it, whatever its case;
   * undefined when it holds one in another form (escaped, spaced, cased otherwise), which only faking hides.
   */
  shown(text: string, kind: FieldType['kind']): string | undefined {
    const lower = text.toLowerCase()
    if (this.#secret(lower) || this.#secret(unescaped(lower))) return undefined
    const whole = this.#values.get(lower)
    if (whole !== undefined) return whole
    let out = text
    // Lowercasing that changes a text's length (İ) leaves no place to match at: the check below finds it instead.
    if (lower.length === text.length) {
      const starts = kind === 'json' ? this.#json : this.#plain
      let from = 0
      out = ''
      for (let at = 0; at + 3 <= lower.length; ) {
        const hit = starts.at(lower, at)
        if (!hit) {
          at++
          continue
        }
        out += text.slice(from, at) + hit[1]
        at += hit[0].length
        from = at
      }
      out += text.slice(from)
    }
    // A label or a boolean, as a word of text (active=true, {"role":"admin"}): a field of its own kind keeps its value.
    if (this.labels.size && kind !== 'boolean' && kind !== 'enum') out = out.replace(WORD, (word) => this.labels.get(word.toLowerCase()) ?? word)
    return this.#squashed(out, this.#counted) || this.#squashed(unescaped(out), this.#counted) ? undefined : out
  }

  #secret(lower: string): boolean {
    return this.secrets.some((secret) => lower.includes(secret))
  }

  #squashed(text: string, words: Set<string>): boolean {
    const squashed = squash(text)
    if (words.has(squashed) || wordsOf(text).some((word) => words.has(word))) return true
    for (let at = 0; at + 6 <= squashed.length; at++) if (this.#long.at(squashed, at)) return true
    return false
  }
}

/** The core's Faker: every value a source returns goes through it, and every fake a client sends comes back through it. */
export function createFaker({ schema, rules, store }: { schema: Schema; rules: Rules; store: Store }): Faker {
  const planOf = planner(schema, rules)
  /** Names of entities and fields: an error quoting one quotes structure, not a value. */
  const names = new Set(
    schema.entities.flatMap((e) => [e.id, e.name, ...e.fields.flatMap((f) => [f.id, f.name, `${e.name}.${f.name}`])]),
  )
  /** A name in the schema, or alias.column as Postgres hints it, when the client wrote that alias. */
  const named = (text: string, sent: string) => {
    if (names.has(text)) return true
    const [alias, column] = text.split('.')
    return /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(text) && names.has(column!) && new RegExp(`\\b${alias}\\b`).test(sent)
  }
  const substitutions = new WeakMap<RequestScope, Map<string, string>>()
  /** Enum labels and booleans each request turned back, lowercased, with the fakes the client sent. */
  const labelled = new WeakMap<RequestScope, Map<string, string>>()
  /** Sosie's own credentials for the upstream, as each request was given them. */
  const hidden = new WeakMap<RequestScope, readonly string[]>()
  const fakerJs = new FakerJs({ locale: [en, base] })

  /** Booleans flip or not, once per domain, by the key. */
  const flips = (domain: string) => (store.seed(domain, '\0boolean')[0]! & 1) === 1
  const flip = (real: string, domain: string) => {
    // Text that is not a boolean, if it ever arrives here, is shaped, never passed.
    if (!BOOLEAN.test(real)) return shape(real, new Random(store.seed(domain, real)))
    if (!flips(domain)) return real
    const truthy = TRUE.test(real)
    const [yes, no] = real.length === 1 ? ['t', 'f'] : real === real.toUpperCase() ? ['TRUE', 'FALSE'] : ['true', 'false']
    return truthy ? no : yes
  }

  /** Enum labels map to other labels of the same enum, by a fixed shuffle per domain. */
  const shuffled = (domain: string, labels: string[]) => new Random(store.seed(domain, '\0enum')).shuffle(labels)

  const scalar = (real: string, type: FieldType & { kind: ScalarKind }, domain: string, plan: Pick<FieldPlan, 'format' | 'unique' | 'words'>) => {
    const draw = (seed: Uint8Array, attempt: number) => {
      const random = new Random(seed)
      fakerJs.seed(random.words())
      return fakeScalar(real, type, plan.format, { random, faker: fakerJs, attempt })
    }
    // Bytes can be large and are never looked up: derived, not stored.
    if (type.kind === 'bytes') return draw(store.seed(domain, real), 0)
    return store.fake(domain, real, { unique: plan.unique, scannable: SCANNABLE.has(type.kind) && !plan.words }, draw)
  }

  /**
   * JSON keys: structure stays, values that are keys are faked and never named in a domain. In a json
   * column, structure is a key that looks like a word. In JSON a query builds (json_object_agg,
   * jsonb_build_object, row_to_json), structure is a name in the schema or a key the client wrote.
   */
  const json = (real: string, domain: string, structure: (key: string) => boolean): string => {
    let doc: unknown
    try {
      doc = JSON.parse(real)
    } catch {
      return scalar(real, { kind: 'string' }, domain, { unique: false })
    }
    const walk = (node: unknown, path: string, key: string): unknown => {
      if (node === null) return null
      if (Array.isArray(node)) return node.map((item) => walk(item, `${path}[]`, key))
      if (typeof node === 'object') {
        return Object.fromEntries(
          Object.entries(node).map(([k, v]) => {
            if (structure(k)) return [k, walk(v, `${path}.${k}`, k)]
            return [scalar(k, { kind: 'string' }, `${domain}.$${path}.*key`, { unique: true }), walk(v, `${path}.*`, '')]
          }),
        )
      }
      const format = formatByName({ name: key })
      const leafDomain = format && PERSONAL.has(format) ? `format:${format}` : `${domain}.$${path}`
      if (typeof node === 'string') return scalar(node, { kind: 'string' }, leafDomain, { unique: true, ...(format && { format }) })
      if (typeof node === 'number') {
        const kind = Number.isInteger(node) ? 'integer' : 'decimal'
        return Number(scalar(String(node), { kind }, leafDomain, { unique: false }))
      }
      if (typeof node === 'boolean') return flips(leafDomain) ? !node : node
      return null
    }
    return JSON.stringify(walk(doc, '', ''))
  }

  const fake = (
    value: Value,
    type: FieldType,
    domain: string,
    plan: Pick<FieldPlan, 'format' | 'unique'>,
    structure: (key: string) => boolean,
  ): Value => {
    if (value === null) return null
    if (Array.isArray(value)) {
      const of = type.kind === 'array' ? type.of : type
      return value.map((item) => fake(item, of, domain, plan, structure))
    }
    switch (type.kind) {
      case 'boolean':
        return flip(value, domain)
      case 'enum': {
        const at = type.labels.indexOf(value)
        const labels = shuffled(domain, type.labels)
        return at >= 0 ? labels[at]! : new Random(store.seed(domain, value)).pick(labels)
      }
      case 'json':
        return json(value, domain, structure)
      case 'unknown':
        return null
      case 'array':
        // A source that could not split an array hands over its text: keep its shape, never its contents.
        return shape(value, new Random(store.seed(domain, value)))
      default:
        return scalar(value, type, domain, plan)
    }
  }

  /** Whether a request turned a fake into this value: as a JSON key, an echo of what the client sent, and never structure. */
  const echoed = (scope: RequestScope | undefined, key: string) => !!scope && turnedBack(scope, key)
  /**
   * Whether text holds a value the request turned back, ignoring case and separators: the value
   * itself, or the value among the text's words (quillon_profile, quillonSettings), or within it
   * when the value is long enough to be no word's part.
   */
  const turnedBack = (scope: RequestScope, text: string) => echoesOf(scope)?.holds(text) ?? false
  /** The values a request turned back, indexed when first asked for and again after the request turns back another. */
  const echoes = new WeakMap<RequestScope, Echoes>()
  const echoesOf = (scope: RequestScope) => {
    const reals = substitutions.get(scope) ?? new Map<string, string>()
    const labels = labelled.get(scope) ?? new Map<string, string>()
    const secrets = hidden.get(scope) ?? []
    if (!reals.size && !labels.size && !secrets.length) return undefined
    let index = echoes.get(scope)
    if (!index) echoes.set(scope, (index = new Echoes(reals, labels, secrets)))
    return index
  }

  /**
   * A value that passes, with each value the request turned back shown as the fake the client sent, whatever
   * the case: an answer that holds it is echoing what the client sent, and the field's rule is not about that.
   * Undefined when it holds one in another form, escaped or spaced or cased otherwise: then it is faked.
   */
  const unechoed = (value: Value, kind: FieldType['kind'], scope: RequestScope | undefined): Value | undefined => {
    const index = scope && echoesOf(scope)
    if (!index || value === null) return value
    if (!Array.isArray(value)) return index.shown(value, kind)
    const items = value.map((item) => unechoed(item, kind, scope))
    return items.includes(undefined) ? undefined : (items as Value[])
  }

  return {
    value(value, field, scope) {
      const plan = planOf(field)
      if (plan.domain === null) {
        const shown = unechoed(value, field.type.kind, scope)
        if (shown !== undefined) return shown
        return fake(value, field.type, `computed:${field.type.kind}`, { unique: false }, (k) => names.has(k) && !echoed(scope, k))
      }
      const out = fake(value, plan.type ?? field.type, plan.domain, plan, (k) => (KEY_WORD.test(k) || names.has(k)) && !echoed(scope, k))
      // A domain shared by fields of different lengths may hold a longer fake than this field takes.
      const max = field.type.kind === 'string' ? field.type.maxLength : undefined
      return max && typeof out === 'string' && out.length > max ? out.slice(0, max) : out
    },

    computed(value, type, sent = '', scope) {
      return fake(value, type, `computed:${type.kind}`, { unique: false }, (k) => (names.has(k) || appears(sent, k)) && !echoed(scope, k))
    },

    passes(field) {
      return planOf(field).domain === null
    },

    request(sent = '', from, secrets) {
      const substituted = new Map<string, string>(from ? substitutions.get(from) : undefined)
      const labels = new Map<string, string>(from ? labelled.get(from) : undefined)

      const lookup = (fakeValue: string, near?: Field): string | undefined => {
        if (!near) {
          const reals = store.reals(fakeValue)
          return reals.length === 1 ? record(reals[0]!, fakeValue) : undefined
        }
        const plan = planOf(near)
        if (plan.domain === null) return undefined
        const type = near.type.kind === 'array' ? near.type.of : near.type
        switch (type.kind) {
          case 'boolean':
            return label(flip(fakeValue, plan.domain), fakeValue)
          case 'enum': {
            const at = shuffled(plan.domain, type.labels).indexOf(fakeValue)
            return at >= 0 ? label(type.labels[at]!, fakeValue) : undefined
          }
          case 'json':
          case 'bytes':
          case 'unknown':
            return undefined
          default: {
            const reals = store.reals(fakeValue, plan.domain)
            return reals.length === 1 ? record(reals[0]!, fakeValue) : undefined
          }
        }
      }

      const label = (real: string, fakeValue: string) => {
        if (real !== fakeValue && labels.get(real.toLowerCase()) !== fakeValue) {
          labels.set(real.toLowerCase(), fakeValue)
          echoes.delete(scope)
        }
        return real
      }

      const record = (real: string, fakeValue: string) => {
        if (real !== fakeValue && substituted.get(real) !== fakeValue) {
          substituted.set(real, fakeValue)
          echoes.delete(scope)
        }
        return real
      }

      const scope: RequestScope = {
        lookup,
        turnedBack: (text) => turnedBack(scope, text),
        scrub(text) {
          let out = text
          for (const [real, fakeValue] of [...substituted].sort((a, b) => b[0].length - a[0].length)) {
            out = out.split(real).join(fakeValue)
          }
          const known = (text: string) => text === '' || appears(sent, text) || named(text, sent)
          // Anything quoted, or any word with a digit, that the client did not send and that names no
          // table or column came from a row.
          return out
            .replace(/"([^"]*)"/g, (whole, inner: string) => (known(inner) ? whole : '"…"'))
            .replace(DIGITS, (token) => {
              const core = token.replace(/[.:+-]+$/, '')
              return (known(core) ? core : '…') + token.slice(core.length)
            })
        },
      }
      substitutions.set(scope, substituted)
      labelled.set(scope, labels)
      const kept = secrets ?? (from ? hidden.get(from) : undefined)
      if (kept?.length) hidden.set(scope, kept)
      return scope
    },
  }
}

export type { Format }
