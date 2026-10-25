import type { Faker } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import type { Analysis } from '../src/guard.js'
import { fakeRow, planColumns } from '../src/results.js'
import { catalog } from './catalog.js'

const analysis = (more: Partial<Analysis> = {}): Analysis => ({ catalogOnly: false, command: 'SELECT', consts: [], params: new Map(), ...more })
const column = (tableID: number, columnID: number, dataTypeID = 25) => ({
  name: 'c',
  tableID,
  columnID,
  dataTypeID,
  dataTypeSize: -1,
  dataTypeModifier: -1,
})

describe('result columns', () => {
  it('names each column’s field by table and position; the rest by type', () => {
    const plans = planColumns([column(100, 2), column(102, 3), column(0, 0, 20), column(1259, 2), column(0, 0, 1007)], analysis(), catalog)
    expect(plans).toEqual([
      { field: catalog.columns.get('100:2') },
      { field: catalog.columns.get('101:2') },
      { type: { kind: 'integer', bytes: 8 } },
      { pass: true },
      { type: { kind: 'array', of: { kind: 'integer', bytes: 4 } } },
    ])
  })

  it('passes count(…) and catalog-only results', () => {
    expect(planColumns([column(0, 0, 20), column(100, 1)], analysis({ targets: ['count', 'star'] }), catalog)[0]).toEqual({ pass: true })
    expect(planColumns([column(100, 1), column(0, 0, 20)], analysis({ targets: ['star', 'count'] }), catalog)[1]).toEqual({ pass: true })
    expect(planColumns([column(1259, 2)], analysis({ catalogOnly: true }), catalog)).toEqual([{ pass: true }])
    // A table Postgres names that Sosie does not know is faked by type, never passed.
    expect(planColumns([column(20000, 1, 17)], analysis({ catalogOnly: true }), catalog)).toEqual([{ type: { kind: 'bytes' } }])
    // A column from a user table is faked even when the guard took the statement for catalog-only.
    expect(planColumns([column(100, 2)], analysis({ catalogOnly: true }), catalog)).toEqual([{ field: catalog.columns.get('100:2') }])
    // A count that is not a bigint is not Postgres's count.
    expect(planColumns([column(0, 0, 25)], analysis({ targets: ['count'] }), catalog)).toEqual([{ type: { kind: 'string' } }])
  })

  it('passes constants the client wrote', () => {
    expect(planColumns([column(0, 0, 23)], analysis({ targets: ['constant'] }), catalog)).toEqual([{ pass: true }])
  })

  it('fakes a cast column as its field', () => {
    const status = catalog.columns.get('100:3')!
    expect(planColumns([column(0, 0, 25)], analysis({ targets: [status] }), catalog)).toEqual([{ field: status }])
  })

  it('fakes arrays element by element', () => {
    const faker = {
      value: (v: unknown) => (Array.isArray(v) ? v.map((x) => (x === null ? null : `f(${x})`)) : `f(${v})`),
      computed: (v: unknown) => `c(${v})`,
    } as unknown as Faker
    const plans = planColumns([column(100, 4), column(100, 2), column(0, 0, 25)], analysis(), catalog)
    expect(fakeRow(['{a,NULL}', 'x', null], plans, faker)).toEqual(['{f(a),NULL}', 'f(x)', null])
  })
})
