import type { Entity, Field, FieldType, Schema } from '@sosie/core'
import { parse as parseYaml } from 'yaml'
import { singular } from './paths.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- an OpenAPI document is JSON of many shapes. */
export type Node = Record<string, any>

/** A GET operation: its path template, and the schema of a successful response. */
export interface Operation {
  /** '/users/{id}', relative to the API's base path. */
  template: string
  /** The template split into segments; a parameter is '{name}'. */
  segments: string[]
  /** The response body's schema, references kept. */
  response?: Node
  /** The entity the response is about, for naming its parameters' fields. */
  entity?: string
}

export interface Api {
  schema: Schema
  operations: Operation[]
  /** Schemas by name, to follow a $ref. */
  schemas: Record<string, Node>
  /** 'OpenAPI 3.1', 'Swagger 2.0'. */
  version: string
}

/** Read an OpenAPI document, JSON or YAML. Throws when it is not one. */
export function parseDocument(text: string): Node {
  const doc = text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text)
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger)) throw new Error('Not an OpenAPI document')
  return doc
}

/**
 * The neutral schema from an OpenAPI document: each object schema is an
 * entity, each property a field (nested objects as dotted names), typed by
 * its JSON Schema type and format.
 */
export function readApi(doc: Node): Api {
  const schemas: Record<string, Node> = doc.components?.schemas ?? doc.definitions ?? {}
  const entities: Entity[] = []
  for (const [name, node] of Object.entries(schemas)) {
    const properties = propertiesOf(node, schemas)
    if (!properties) continue
    const fields: Field[] = []
    const add = (props: Record<string, Node>, prefix: string) => {
      for (const [key, raw] of Object.entries(props)) {
        const prop = merged(raw, schemas)
        // A property that is another entity is that entity's row, not a field of this one.
        if (raw.$ref || (prop.type === 'array' && prop.items?.$ref)) continue
        const nested = !raw.$ref && propertiesOf(prop, schemas)
        if (nested && prop.type !== 'array') {
          add(nested, `${prefix}${key}.`)
          continue
        }
        fields.push({
          id: `${name}.${prefix}${key}`,
          name: key,
          type: typeOf(prop, schemas),
          ...(key === 'id' && !prefix && { key: 'primary' as const }),
          ...(formatOf(prop) && { format: formatOf(prop) }),
        })
      }
    }
    add(properties, '')
    entities.push({ id: name, name, fields })
  }
  link(entities)

  const operations: Operation[] = []
  for (const [template, item] of Object.entries<Node>(doc.paths ?? {})) {
    const get = item?.get
    if (!get) continue
    const responses: Node = get.responses ?? {}
    const ok = responses['200'] ?? Object.entries(responses).find(([code]) => /^2\d\d$/.test(code))?.[1]
    const response = ok?.content?.['application/json']?.schema ?? ok?.schema
    operations.push({
      template,
      segments: template.split('/').filter(Boolean),
      ...(response && { response }),
      ...(response && entityOf(response, schemas) && { entity: entityOf(response, schemas) }),
    })
  }
  // The most specific template first: /users/me before /users/{id}.
  operations.sort((a, b) => b.segments.filter((s) => !s.startsWith('{')).length - a.segments.filter((s) => !s.startsWith('{')).length)

  const version = doc.openapi ? `OpenAPI ${String(doc.openapi).split('.').slice(0, 2).join('.')}` : `Swagger ${doc.swagger}`
  return { schema: { entities }, operations, schemas, version }
}

/** A field named like `userId` or `user_id` shares the values of the id of the entity it names. */
export function link(entities: Entity[]): void {
  const byName = new Map(entities.map((e) => [singular(e.name.toLowerCase()), e]))
  for (const entity of entities) {
    for (const field of entity.fields) {
      const target = referenceOf(field.name, (name) => byName.get(name))
      if (target && target.id !== entity.id && target.fields.some((f) => f.id === `${target.id}.id`)) field.references = `${target.id}.id`
    }
  }
}

/** The entity a key like `userId`, `user_id` or `userIds` refers to, by name. */
export function referenceOf<T>(key: string, find: (name: string) => T | undefined): T | undefined {
  const m = /^(.+?)(?:Id|_id|Ids|_ids)$/.exec(key)
  return m ? find(singular(m[1]!.toLowerCase())) : undefined
}

/** The entity a response schema is about: a $ref, or an array of them. */
export function entityOf(node: Node | undefined, schemas: Record<string, Node>): string | undefined {
  if (!node) return undefined
  if (node.$ref) return refName(node.$ref)
  if (node.type === 'array') return entityOf(node.items, schemas)
  return undefined
}

export function refName(ref: string): string {
  return ref.split('/').at(-1)!
}

/** A schema with its $ref followed and its allOf merged. */
export function merged(node: Node | undefined, schemas: Record<string, Node>, depth = 0): Node {
  if (!node || depth > 20) return {}
  if (node.$ref) return merged(schemas[refName(node.$ref)], schemas, depth + 1)
  if (!node.allOf) return node
  const parts = (node.allOf as Node[]).map((part) => merged(part, schemas, depth + 1))
  return {
    ...node,
    type: 'object',
    properties: Object.assign({}, ...parts.map((p) => p.properties ?? {}), node.properties ?? {}),
  }
}

function propertiesOf(node: Node, schemas: Record<string, Node>): Record<string, Node> | undefined {
  const m = merged(node, schemas)
  return m.properties && (m.type === 'object' || m.type === undefined) ? m.properties : undefined
}

function typeOf(node: Node, schemas: Record<string, Node>): FieldType {
  const type = Array.isArray(node.type) ? node.type.find((t: string) => t !== 'null') : node.type
  if (Array.isArray(node.enum) && node.enum.every((v: unknown) => typeof v === 'string')) return { kind: 'enum', labels: node.enum }
  switch (type) {
    case 'string':
      switch (node.format) {
        case 'date':
          return { kind: 'date' }
        case 'date-time':
          return { kind: 'datetime' }
        case 'time':
          return { kind: 'time' }
        case 'uuid':
          return { kind: 'uuid' }
        case 'ipv4':
        case 'ipv6':
          return { kind: 'ip' }
        default:
          return typeof node.maxLength === 'number' ? { kind: 'string', maxLength: node.maxLength } : { kind: 'string' }
      }
    case 'integer':
      return { kind: 'integer', bytes: node.format === 'int32' ? 4 : 8 }
    case 'number':
      return { kind: 'decimal' }
    case 'boolean':
      return { kind: 'boolean' }
    case 'array':
      return { kind: 'array', of: typeOf(merged(node.items, schemas), schemas) }
    default:
      return { kind: 'json' }
  }
}

function formatOf(node: Node): string | undefined {
  if (node.format === 'email') return 'email'
  if (node.format === 'uri' || node.format === 'url') return 'url'
  return undefined
}
