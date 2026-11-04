import type { RequestScope } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import { inClientText, quote, rewriteConsts } from '../src/rewrite.js'
import { buildCatalog, enumLabels, typeOf, typeOfColumn } from '../src/schema.js'

describe('the catalog', () => {
  it('reads each column type as a neutral one', () => {
    expect(typeOf('tinyint', 'tinyint(1)')).toEqual({ kind: 'boolean' })
    expect(typeOf('tinyint', 'tinyint unsigned')).toEqual({ kind: 'integer', bytes: 2 })
    expect(typeOf('bigint', 'bigint')).toEqual({ kind: 'integer', bytes: 8 })
    expect(typeOf('decimal', 'decimal(8,2)')).toEqual({ kind: 'decimal' })
    expect(typeOf('varchar', 'varchar(120)', 120)).toEqual({ kind: 'string', maxLength: 120 })
    expect(typeOf('longtext')).toEqual({ kind: 'string' })
    expect(typeOf('blob')).toEqual({ kind: 'bytes' })
    expect(typeOf('datetime')).toEqual({ kind: 'datetime' })
    expect(typeOf('json')).toEqual({ kind: 'json' })
    expect(typeOf('enum', "enum('a','it''s')")).toEqual({ kind: 'enum', labels: ['a', "it's"] })
    expect(typeOf('geometry')).toEqual({ kind: 'unknown' })
    expect(enumLabels("enum('x','y\\'z')")).toEqual(['x', "y'z"])
  })

  it('reads a result column it holds no field for by its protocol type', () => {
    expect(typeOfColumn(8, 63, 0)).toEqual({ kind: 'integer', bytes: 8 })
    expect(typeOfColumn(253, 255, 0)).toEqual({ kind: 'string' })
    expect(typeOfColumn(252, 63, 0)).toEqual({ kind: 'bytes' })
    expect(typeOfColumn(254, 255, 256)).toEqual({ kind: 'string' })
    expect(typeOfColumn(255, 63, 0)).toEqual({ kind: 'unknown' })
  })

  it('names fields by table, and by database outside the one connected to; references and keys from the catalog', () => {
    const catalog = buildCatalog({
      database: 'app',
      tables: [
        { db: 'app', name: 'users', kind: 'BASE TABLE' },
        { db: 'other', name: 'orders', kind: 'BASE TABLE' },
        { db: 'app', name: 'active', kind: 'VIEW' },
      ],
      columns: [
        { db: 'app', table: 'users', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
        { db: 'other', table: 'orders', name: 'user_id', dataType: 'int', columnType: 'int', maxLength: null },
        { db: 'app', table: 'active', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
      ],
      primary: [{ db: 'app', table: 'users', column: 'id' }],
      unique: [],
      references: [{ db: 'other', table: 'orders', column: 'user_id', refDb: 'app', refTable: 'users', refColumn: 'id' }],
      functions: [],
      grants: ['GRANT SELECT, INSERT ON `app`.* TO `x`@`%`'],
    })
    expect(catalog.schema.entities.map((e) => e.id)).toEqual(['users', 'other.orders', 'active'])
    expect(catalog.columns.get('other.orders.user_id')).toMatchObject({ id: 'other.orders.user_id', references: 'users.id' })
    expect(catalog.columns.get('app.users.id')).toMatchObject({ key: 'primary' })
    expect([catalog.tables, catalog.views, catalog.writable, catalog.admin]).toEqual([2, 1, true, false])
  })
})

describe('views', () => {
  const rows = (viewUses?: { db: string; view: string; tableDb: string; table: string }[]) =>
    buildCatalog({
      database: 'app',
      tables: [
        { db: 'app', name: 'users', kind: 'BASE TABLE' },
        { db: 'app', name: 'orders', kind: 'BASE TABLE' },
        { db: 'app', name: 'active', kind: 'VIEW' },
      ],
      columns: [
        { db: 'app', table: 'users', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
        { db: 'app', table: 'users', name: 'email', dataType: 'varchar', columnType: 'varchar(9)', maxLength: 9 },
        { db: 'app', table: 'orders', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
        { db: 'app', table: 'active', name: 'id', dataType: 'int', columnType: 'int', maxLength: null },
        { db: 'app', table: 'active', name: 'email', dataType: 'varchar', columnType: 'varchar(9)', maxLength: 9 },
      ],
      ...(viewUses && { viewUses }),
      primary: [],
      unique: [],
      references: [],
      functions: [],
      grants: [],
    })

  it('share their table’s values, by the tables the view reads (SHOW VIEW)', () => {
    const catalog = rows([{ db: 'app', view: 'active', tableDb: 'app', table: 'users' }])
    expect(catalog.columns.get('app.active.id')?.references).toBe('users.id')
    expect(catalog.columns.get('app.active.email')?.references).toBe('users.email')
    expect(catalog.hiddenViews).toBe(0)
  })

  it('without SHOW VIEW, share only what one table of the database has a column for', () => {
    const catalog = rows([])
    expect(catalog.columns.get('app.active.email')?.references).toBe('users.email')
    // users and orders both have an id: the view's is its own.
    expect(catalog.columns.get('app.active.id')?.references).toBeUndefined()
    expect(catalog.hiddenViews).toBe(1)
  })
})

describe('turning fakes back', () => {
  const scope = (map: Record<string, string>) => ({ lookup: (fake: string) => map[fake], turnedBack: () => false, scrub: (t: string) => t }) as RequestScope

  it('replaces only the literals it turns back, where they are', () => {
    const sql = "SELECT * FROM users WHERE email = 'fake@x.io' AND id = 9 AND note = 'keep'"
    const consts = [
      { start: sql.indexOf("'fake"), end: sql.indexOf("'fake") + 11, value: 'fake@x.io', kind: 'string' as const, near: undefined },
      { start: sql.indexOf('9'), end: sql.indexOf('9') + 1, value: '9', kind: 'number' as const, near: undefined },
    ]
    const rewritten = rewriteConsts(sql, consts, scope({ 'fake@x.io': "o'brien@real.io", '9': '42' }))
    expect(rewritten?.sql).toBe("SELECT * FROM users WHERE email = 'o\\'brien@real.io' AND id = 42 AND note = 'keep'")
    expect(rewriteConsts(sql, consts, scope({}))).toBeUndefined()
    // A place in what was sent, back in the client's text; inside a value Sosie put there, at its start.
    const { edits } = rewritten!
    const sent = rewritten!.sql
    expect(inClientText(sent.indexOf('AND id'), edits)).toBe(sql.indexOf('AND id'))
    expect(inClientText(sent.indexOf('AND note'), edits)).toBe(sql.indexOf('AND note'))
    expect(inClientText(sent.indexOf('brien'), edits)).toBe(sql.indexOf("'fake"))
    expect(inClientText(3, edits)).toBe(3)
  })

  it('quotes as MySQL reads a string with backslash escapes', () => {
    expect(quote("a'b\\c\n\0")).toBe("'a\\'b\\\\c\\n\\0'")
  })
})
