import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeRunning } from '@sosie/core'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The plugin in plugins/sosie ships with the CLI: the same version, and its MCP server and its hooks run that
 * version, so a release that forgets the plugin fails here.
 */
const root = new URL('..', import.meta.url).pathname
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const cli = json('packages/cli/package.json').version as string

describe('the plugin', () => {
  it('has the version of @sosie/cli', () => {
    expect(json('plugins/sosie/plugin.json').version).toBe(cli)
    expect(json('plugins/sosie/.claude-plugin/plugin.json').version).toBe(cli)
  })

  it('runs @sosie/cli at that version, for every assistant and for Claude Code', () => {
    expect(json('plugins/sosie/mcp.json').mcpServers.sosie.args).toEqual(['-y', `@sosie/cli@${cli}`, 'mcp'])
    expect(json('plugins/sosie/.mcp.json').mcpServers.sosie.args).toEqual(['-y', `@sosie/cli@${cli}`, 'mcp'])
  })

  describe('its hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-plugin-'))
    const before = process.env.SOSIE_HOME
    afterAll(() => {
      if (before === undefined) delete process.env.SOSIE_HOME
      else process.env.SOSIE_HOME = before
      rmSync(home, { recursive: true, force: true })
    })

    it('read the Sosies running as the core writes them', async () => {
      process.env.SOSIE_HOME = home
      const hooks: { running(): unknown[]; cli(): string } = await import(pathToFileURL(join(root, 'plugins/sosie/hooks/sosie.mjs')).href)
      expect(hooks.running()).toEqual([])
      writeRunning(home, { kind: 'postgres', address: 'postgres://localhost:7674/app', schema: { entities: [] }, passing: [] })
      expect(hooks.running()).toEqual([{ kind: 'postgres', address: 'postgres://localhost:7674/app' }])
      expect(hooks.cli()).toBe(`@sosie/cli@${cli}`)
    })
  })
})
