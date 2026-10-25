import { buildCatalog } from '../src/schema.js'

/** A small catalog, as readCatalog would build it from pg_catalog rows. */
export const catalog = buildCatalog({
  relations: [
    { oid: 100, nspname: 'public', relname: 'users', relkind: 'r', parent: null },
    { oid: 101, nspname: 'public', relname: 'orders', relkind: 'p', parent: null },
    { oid: 102, nspname: 'public', relname: 'orders_2025', relkind: 'r', parent: 101 },
    { oid: 103, nspname: 'public', relname: 'active_users', relkind: 'v', parent: null },
    { oid: 104, nspname: 'billing', relname: 'invoices', relkind: 'r', parent: null },
  ],
  columns: [
    col(100, 1, 'id', 'int4'),
    col(100, 2, 'email', 'varchar', 124),
    col(100, 3, 'status', 'mood', -1, { typtype: 'e', enumtypid: 900 }),
    col(100, 4, 'tags', '_text', -1, { typcategory: 'A', element: 'text', element_type: 'b' }),
    col(100, 5, 'code', 'short_code', -1, { typtype: 'd', basetype: 'varchar' }),
    col(101, 1, 'id', 'int8'),
    col(101, 2, 'user_id', 'int4'),
    col(102, 1, 'id', 'int8'),
    col(102, 3, 'user_id', 'int4'),
    col(103, 1, 'id', 'int4'),
    col(103, 2, 'email', 'varchar', 124),
    col(104, 1, 'id', 'int4'),
    col(104, 2, 'order_id', 'int8'),
    col(104, 3, 'amount', 'numeric', 655366),
  ],
  constraints: [
    { conrelid: 100, contype: 'p', conkey: [1], confrelid: 0, confkey: null },
    { conrelid: 100, contype: 'u', conkey: [2], confrelid: 0, confkey: null },
    { conrelid: 101, contype: 'p', conkey: [1], confrelid: 0, confkey: null },
    { conrelid: 101, contype: 'f', conkey: [2], confrelid: 100, confkey: [1] },
    { conrelid: 104, contype: 'f', conkey: [2], confrelid: 101, confkey: [1] },
  ],
  enums: new Map([[900, ['sad', 'ok', 'happy']]]),
  views: [
    { view: 103, relation: 100, attnum: 1 },
    { view: 103, relation: 100, attnum: 2 },
  ],
  functions: ['user_email'],
  operators: ['###'],
  types: ['mood', 'short_code'],
  writable: 0,
  admin: false,
})

function col(attrelid: number, attnum: number, attname: string, typname: string, atttypmod = -1, more: object = {}) {
  return {
    attrelid,
    attnum,
    attname,
    atttypmod,
    typname,
    typtype: 'b',
    typcategory: 'S',
    element: null,
    element_type: null,
    basetype: null,
    enumtypid: null,
    ...more,
  }
}
