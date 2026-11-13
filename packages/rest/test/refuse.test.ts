import { describe, expect, it } from 'vitest'
import { refuser } from '../src/refuse.js'

const refuses = (patterns: string[], path: string) => refuser(patterns)(path.split('/').filter(Boolean).map(decodeURIComponent))

describe('the paths sosie.yml refuses', () => {
  it('refuses a path and every path under it, a * or a {name} as any one segment', () => {
    expect(refuses(['/billing/portal'], '/billing/portal')).toBe(true)
    expect(refuses(['/billing/portal'], '/billing/portal/session')).toBe(true)
    expect(refuses(['/billing/portal'], '/billing')).toBe(false)
    expect(refuses(['/billing/portal'], '/billing/portals')).toBe(false)
    expect(refuses(['/oauth/*'], '/oauth/google/callback')).toBe(true)
    expect(refuses(['/oauth/*'], '/oauth')).toBe(false)
    expect(refuses(['/users/{id}/sessions'], '/users/42/sessions')).toBe(true)
    expect(refuses(['/users/{id}/sessions'], '/users/42/orders')).toBe(false)
    expect(refuses(['/exports/report*'], '/exports/report-2026.csv')).toBe(true)
    expect(refuses(['/exports/report*'], '/exports/summary')).toBe(false)
    expect(refuses(['/a', '/b'], '/b/c')).toBe(true)
  })

  it('refuses it however a server may read it: in any case, with ;params, encoded twice, with a trailing or a doubled /', () => {
    for (const path of ['/Billing/PORTAL', '/billing;jsessionid=1/portal', '/billing/%2570ortal', '/billing/portal/', '//billing//portal']) {
      expect(refuses(['/billing/portal'], path), path).toBe(true)
    }
    // A pattern may be written encoded too.
    expect(refuses(['/billing%20portal'], '/billing portal')).toBe(true)
  })
})
