import type { Entity, Field, FieldType, Schema } from '@sosie/core'
import type { Document } from 'bson'
import { collection, pipeline, type Shape } from './shape.js'

/** What Sosie knows of the database: its collections, and each field met so far, or named by a validator. */
export class Catalog {
  readonly schema: Schema = { entities: [] }
  readonly #entities = new Map<string, Entity>()
  readonly #fields = new Map<string, Field>()
  collections = 0
  views = 0
  /** The connection string's database's views: the collection each reads, and its pipeline. */
  readonly #views = new Map<string, { viewOn: string; pipeline: Document[] }>()

  constructor(readonly database: string) {}

  addView(name: string, viewOn: string, stages: Document[]): void {
    this.#views.set(this.entityOf(this.database, name), { viewOn, pipeline: stages })
  }

  /**
   * The shape of a collection's documents: a view's are its pipeline's over the collection it reads, so a view's
   * email is its collection's, and fakes as it does. A view of a view is read through both.
   */
  start(db: string, name: string, seen = new Set<string>()): Shape {
    const entity = this.entityOf(db, name)
    const view = this.#views.get(entity)
    if (!view || seen.has(entity)) return collection(entity)
    return pipeline(view.pipeline, this.start(db, view.viewOn, new Set(seen).add(entity)), (other) => this.entityOf(db, other))
  }

  /** A collection's entity id: its name in the connection string's database, database.name in another. */
  entityOf(db: string, collection: string): string {
    return db === this.database ? collection : `${db}.${collection}`
  }

  /** The entity of a collection, made when first named. */
  entity(id: string): Entity {
    let entity = this.#entities.get(id)
    if (!entity) {
      entity = { id, name: id.split('.').at(-1)!, fields: [] }
      this.#entities.set(id, entity)
      this.schema.entities.push(entity)
    }
    return entity
  }

  /** A field met in a document; true when it is new. */
  meet(entityId: string, path: string, type: FieldType): boolean {
    const id = `${entityId}.${path}`
    if (this.#fields.has(id)) return false
    const field: Field = { id, name: path.split('.').at(-1) || 'value', type, ...(path === '_id' && { key: 'primary' as const }) }
    this.#fields.set(id, field)
    this.entity(entityId).fields.push(field)
    return true
  }
}

/** BSON's type names, as $jsonSchema's bsonType gives them, in neutral terms. */
const BSON_TYPES: Record<string, FieldType> = {
  string: { kind: 'string' },
  int: { kind: 'integer', bytes: 4 },
  long: { kind: 'integer', bytes: 8 },
  double: { kind: 'decimal' },
  decimal: { kind: 'decimal' },
  number: { kind: 'decimal' },
  bool: { kind: 'boolean' },
  date: { kind: 'datetime' },
  objectId: { kind: 'objectid' },
  binData: { kind: 'bytes' },
}

/** The collections of the database, and the fields their validators name, from listCollections. */
export function readCollections(catalog: Catalog, collections: Document[]): void {
  for (const info of collections) {
    const name = String(info.name)
    if (name.startsWith('system.')) continue
    const options = (info.options ?? {}) as Document
    if (info.type === 'view') {
      catalog.views++
      if (typeof options.viewOn === 'string' && Array.isArray(options.pipeline)) catalog.addView(name, options.viewOn, options.pipeline as Document[])
    } else catalog.collections++
    const entity = catalog.entityOf(catalog.database, name)
    catalog.entity(entity)
    const schema = (info.options as Document | undefined)?.validator?.$jsonSchema as Document | undefined
    if (schema) properties(catalog, entity, '', schema)
  }
}

function properties(catalog: Catalog, entity: string, prefix: string, schema: Document): void {
  for (const [key, spec] of Object.entries((schema.properties ?? {}) as Record<string, Document>)) {
    const path = `${prefix}${key}`
    const bsonType = Array.isArray(spec.bsonType) ? spec.bsonType.find((t: string) => t !== 'null') : spec.bsonType
    if (bsonType === 'object' && spec.properties) properties(catalog, entity, `${path}.`, spec)
    else if (bsonType === 'array' && spec.items && typeof spec.items === 'object' && !Array.isArray(spec.items)) {
      const items = spec.items as Document
      const itemType = Array.isArray(items.bsonType) ? items.bsonType.find((t: string) => t !== 'null') : items.bsonType
      if (itemType === 'object' && items.properties) properties(catalog, entity, `${path}.`, items)
      else if (BSON_TYPES[itemType]) catalog.meet(entity, path, BSON_TYPES[itemType]!)
    } else if (Array.isArray(spec.enum) && spec.enum.every((v: unknown) => typeof v === 'string')) {
      catalog.meet(entity, path, { kind: 'enum', labels: spec.enum as string[] })
    } else if (BSON_TYPES[bsonType]) catalog.meet(entity, path, BSON_TYPES[bsonType]!)
  }
}
