import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The dependency rule: the core depends on no source; a source depends on the
 * core only, never on another source; the CLI brings them together.
 */
const root = new URL('..', import.meta.url).pathname
const SOURCES = ['@sosie/postgres', '@sosie/rest', '@sosie/graphql']

function imports(pkg: string): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.name.endsWith('.ts')) files.push(join(dir, entry.name))
    }
  }
  walk(join(root, 'packages', pkg, 'src'))
  return files.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^'.][^']*)'/g)].map((m) => m[1]!.split('/').slice(0, m[1]!.startsWith('@') ? 2 : 1).join('/')),
  )
}

function dependencies(pkg: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'))
  return Object.keys(manifest.dependencies ?? {})
}

describe('the dependency rule', () => {
  it('the core depends on no source, and on no database client', () => {
    expect(imports('core')).toContain('@faker-js/faker')
    for (const name of [...imports('core'), ...dependencies('core')]) {
      expect(name.startsWith('@sosie/')).toBe(false)
      expect(['pg', 'pgsql-parser', 'postgres']).not.toContain(name)
    }
  })

  it.each(['postgres', 'rest', 'graphql'])('the %s source depends on the core only', (source) => {
    const sosie = [...imports(source), ...dependencies(source)].filter((n) => n.startsWith('@sosie/'))
    expect(new Set(sosie)).toEqual(new Set(['@sosie/core']))
  })

  it('the CLI brings the core and the sources together', () => {
    const sosie = new Set(dependencies('cli').filter((n) => n.startsWith('@sosie/')))
    expect(sosie).toEqual(new Set(['@sosie/core', ...SOURCES]))
  })
})
