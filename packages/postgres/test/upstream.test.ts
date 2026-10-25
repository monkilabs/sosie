import { describe, expect, it } from 'vitest'
import { config } from '../src/upstream.js'

describe('the upstream session', () => {
  it('is read-only from its start-up, and the connection string cannot undo it', () => {
    const url = new URL(
      'postgres://kim:secret@db:5432/app?sslmode=require&options=-c%20search_path%3Dbilling&statement_timeout=0&client_encoding=SJIS&replication=database&lock_timeout=0',
    )
    const c = config(url, { statementTimeout: 30_000 })
    const string = new URL(c.connectionString!)
    expect([...string.searchParams.keys()]).toEqual(['sslmode'])
    expect(c.options).toBe(
      '-c search_path=billing -c default_transaction_read_only=on -c statement_timeout=30000 -c idle_in_transaction_session_timeout=300000 -c DateStyle=ISO,MDY -c IntervalStyle=postgres -c bytea_output=hex -c standard_conforming_strings=on -c client_encoding=UTF8',
    )
  })
})
