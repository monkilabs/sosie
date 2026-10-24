import { base, en, Faker as FakerJs } from '@faker-js/faker'
import { planFields, type FieldPlan } from '../domains.js'
import type { Rules } from '../rules.js'
import type { Store } from '../store.js'
import type { Faker, Field, FieldType, RequestScope, Schema, Value } from '../source.js'
import { formatByName, PERSONAL, type Format } from './formats.js'
import { Random, shape } from './random.js'
import { fakeScalar, type ScalarKind } from './types.js'

const SCANNABLE = new Set<FieldType['kind']>(['string', 'integer', 'decimal', 'uuid', 'ip'])
const TRUE = /^(t|true|y|yes|on|1)$/i

/** The core's Faker: every value a source returns goes through it, and every fake a client sends comes back through it. */
export function createFaker({ schema, rules, store }: { schema: Schema; rules: Rules; store: Store }): Faker {
  const plans = planFields(schema, rules)
  const substitutions = new WeakMap<RequestScope, Map<string, string>>()
  const fakerJs = new FakerJs({ locale: [en, base] })

  const planOf = (field: Field): FieldPlan =>
    plans.get(field.id) ?? { domain: field.id, unique: !!field.key || field.type.kind === 'string' }

  /** Booleans flip or not, once per domain, by the key. */
  const flips = (domain: string) => (store.seed(domain, '\0boolean')[0]! & 1) === 1
  const flip = (real: string, domain: string) => {
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

  const json = (real: string, domain: string): string => {
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
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, `${path}.${k}`, k)]))
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

  const fake = (value: Value, type: FieldType, domain: string, plan: Pick<FieldPlan, 'format' | 'unique'>): Value => {
    if (value === null) return null
    if (Array.isArray(value)) {
      const of = type.kind === 'array' ? type.of : type
      return value.map((item) => fake(item, of, domain, plan))
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
        return json(value, domain)
      case 'unknown':
        return null
      case 'array':
        // A source that could not split an array hands over its text: keep its shape, never its contents.
        return shape(value, new Random(store.seed(domain, value)))
      default:
        return scalar(value, type, domain, plan)
    }
  }

  return {
    value(value, field) {
      const plan = planOf(field)
      if (plan.domain === null) return value
      const out = fake(value, plan.type ?? field.type, plan.domain, plan)
      // A domain shared by fields of different lengths may hold a longer fake than this field takes.
      const max = field.type.kind === 'string' ? field.type.maxLength : undefined
      return max && typeof out === 'string' && out.length > max ? out.slice(0, max) : out
    },

    computed(value, type) {
      return fake(value, type, `computed:${type.kind}`, { unique: false })
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
        scrub(text) {
          let out = text
          for (const [real, fakeValue] of [...substituted].sort((a, b) => b[0].length - a[0].length)) {
            out = out.split(real).join(fakeValue)
          }
          // Anything quoted that the client did not send came from a row.
          return out.replace(/"([^"]*)"/g, (whole, inner: string) => (inner === '' || sent.includes(inner) ? whole : '"…"'))
        },
      }
      substitutions.set(scope, substituted)
      return scope
    },
  }
}

export type { Format }
