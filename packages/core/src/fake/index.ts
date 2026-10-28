import { base, en, Faker as FakerJs } from '@faker-js/faker'
import { planner, type FieldPlan } from '../domains.js'
import type { Rules } from '../rules.js'
import type { Store } from '../store.js'
import type { Faker, Field, FieldType, Pace, RequestScope, Schema, Value } from '../source.js'
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

/** Faking as steps, one per value of a JSON document: run at once, or paced, so other clients are answered between steps. */
type Steps<T> = Generator<void, T, void>

function run<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

async function runPaced<T>(steps: Steps<T>, pace: Pace): Promise<T> {
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    const pause = pace()
    if (pause) await pause
  }
}

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

  const scalar = (real: string, type: FieldType & { kind: ScalarKind }, domain: string, plan: Pick<FieldPlan, 'format' | 'unique'>) => {
    const draw = (seed: Uint8Array, attempt: number) => {
      const random = new Random(seed)
      fakerJs.seed(random.words())
      return fakeScalar(real, type, plan.format, { random, faker: fakerJs, attempt })
    }
    // Bytes can be large and are never looked up: derived, not stored.
    if (type.kind === 'bytes') return draw(store.seed(domain, real), 0)
    return store.fake(domain, real, { unique: plan.unique, scannable: SCANNABLE.has(type.kind) }, draw)
  }

  /**
   * JSON keys: structure stays, values that are keys are faked and never named in a domain. In a json
   * column, structure is a key that looks like a word. In JSON a query builds (json_object_agg,
   * jsonb_build_object, row_to_json), structure is a name in the schema or a key the client wrote.
   */
  function* json(real: string, domain: string, structure: (key: string) => boolean): Steps<string> {
    let doc: unknown
    try {
      doc = JSON.parse(real)
    } catch {
      return scalar(real, { kind: 'string' }, domain, { unique: false })
    }
    function* walk(node: unknown, path: string, key: string): Steps<unknown> {
      if (node === null) return null
      if (Array.isArray(node)) {
        const out: unknown[] = []
        for (const item of node) out.push(yield* walk(item, `${path}[]`, key))
        return out
      }
      if (typeof node === 'object') {
        const out: [string, unknown][] = []
        for (const [k, v] of Object.entries(node)) {
          if (structure(k)) out.push([k, yield* walk(v, `${path}.${k}`, k)])
          else out.push([scalar(k, { kind: 'string' }, `${domain}.$${path}.*key`, { unique: true }), yield* walk(v, `${path}.*`, '')])
        }
        return Object.fromEntries(out)
      }
      // One value at a time: a caller that paces may let other clients in here.
      yield
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
    return JSON.stringify(yield* walk(doc, '', ''))
  }

  function* fake(
    value: Value,
    type: FieldType,
    domain: string,
    plan: Pick<FieldPlan, 'format' | 'unique'>,
    structure: (key: string) => boolean,
  ): Steps<Value> {
    if (value === null) return null
    if (Array.isArray(value)) {
      const of = type.kind === 'array' ? type.of : type
      const out: Value[] = []
      for (const item of value) out.push(yield* fake(item, of, domain, plan, structure))
      return out
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
        return yield* json(value, domain, structure)
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
  const turnedBack = (scope: RequestScope, text: string) => {
    const reals = substitutions.get(scope)
    if (!reals?.size) return false
    const lower = text.toLowerCase()
    const squashed = squash(text)
    const parts = new Set(wordsOf(text))
    for (const real of reals.keys()) {
      if (real.toLowerCase() === lower) return true
      const whole = squash(real)
      if (whole.length >= 3 && (whole === squashed || parts.has(whole) || (whole.length >= 6 && squashed.includes(whole)))) return true
    }
    return false
  }

  /**
   * A value that passes, with each value the request turned back shown as the fake the client sent, whatever
   * the case: an answer that holds it is echoing what the client sent, and the field's rule is not about that.
   */
  const unechoed = (value: Value, kind: FieldType['kind'], scope: RequestScope | undefined): Value => {
    const reals = scope && substitutions.get(scope)
    if (!reals?.size || value === null) return value
    if (Array.isArray(value)) return value.map((item) => unechoed(item, kind, scope))
    let out = value
    for (const [real, fakeValue] of [...reals].sort((a, b) => b[0].length - a[0].length)) {
      // A short number may be any other number, a passing count or quantity: an echo has a letter, or is long.
      if (!/\p{L}/u.test(real) && real.length < 6) continue
      if (out.toLowerCase() === real.toLowerCase()) return fakeValue
      if (real.length < 3) continue
      const form = (text: string) => (kind === 'json' ? JSON.stringify(text).slice(1, -1) : text)
      out = out.replace(new RegExp(form(real).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), () => form(fakeValue))
    }
    return out
  }

  function* ofField(value: Value, field: Field, scope: RequestScope | undefined): Steps<Value> {
    const plan = planOf(field)
    if (plan.domain === null) return unechoed(value, field.type.kind, scope)
    const out = yield* fake(value, plan.type ?? field.type, plan.domain, plan, (k) => (KEY_WORD.test(k) || names.has(k)) && !echoed(scope, k))
    // A domain shared by fields of different lengths may hold a longer fake than this field takes.
    const max = field.type.kind === 'string' ? field.type.maxLength : undefined
    return max && typeof out === 'string' && out.length > max ? out.slice(0, max) : out
  }

  const ofNoField = (value: Value, type: FieldType, sent: string, scope: RequestScope | undefined) =>
    fake(value, type, `computed:${type.kind}`, { unique: false }, (k) => (names.has(k) || appears(sent, k)) && !echoed(scope, k))

  return {
    value(value, field, scope) {
      return run(ofField(value, field, scope))
    },

    computed(value, type, sent = '', scope) {
      return run(ofNoField(value, type, sent, scope))
    },

    valuePaced(value, field, scope, pace) {
      return runPaced(ofField(value, field, scope), pace)
    },

    computedPaced(value, type, sent, scope, pace) {
      return runPaced(ofNoField(value, type, sent, scope), pace)
    },

    passes(field) {
      return planOf(field).domain === null
    },

    request(sent = '', from) {
      const substituted = new Map<string, string>(from ? substitutions.get(from) : undefined)

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
            return flip(fakeValue, plan.domain)
          case 'enum': {
            const at = shuffled(plan.domain, type.labels).indexOf(fakeValue)
            return at >= 0 ? type.labels[at] : undefined
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

      const record = (real: string, fakeValue: string) => {
        if (real !== fakeValue) substituted.set(real, fakeValue)
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
      return scope
    },
  }
}

export type { Format }
