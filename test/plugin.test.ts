import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeRunning } from '@sosie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The plugin in plugins/sosie ships with the CLI: the same version, and its MCP server and its hooks run that
 * version, so a release that forgets the plugin fails here. Its hooks run in Claude Code, Copilot CLI and VS Code,
 * each with its own events and payloads.
 */
const root = new URL('..', import.meta.url).pathname
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const cli = json('packages/cli/package.json').version as string
const hooksDir = join(root, 'plugins/sosie/hooks')

interface Hooks {
  running(): unknown[]
  cli(): string
  sessionFiles(event: Record<string, unknown>, env?: Record<string, string | undefined>): string[]
  takeScans(): { transcript: string; findings?: { file: string; line: number; field: string }[] }[]
  scanPaths(session: string): { out: string; lock: string; again: string }
  keep(file: string, result: unknown): void
}

describe('the plugin', () => {
  it('has the version of @sosie/cli', () => {
    expect(json('plugins/sosie/plugin.json').version).toBe(cli)
    expect(json('plugins/sosie/.claude-plugin/plugin.json').version).toBe(cli)
  })

  it('runs @sosie/cli at that version, for every assistant and for Claude Code', () => {
    expect(json('plugins/sosie/mcp.json').mcpServers.sosie.args).toEqual(['-y', `@sosie/cli@${cli}`, 'mcp'])
    expect(json('plugins/sosie/.mcp.json').mcpServers.sosie.args).toEqual(['-y', `@sosie/cli@${cli}`, 'mcp'])
  })

  it('names, for each assistant, scripts that are there, by the token that assistant replaces', () => {
    // Claude Code and Copilot CLI read hooks/hooks.json; VS Code, for an Agent Plugin, its namespace's.
    const files: [string, string, string[]][] = [
      ['plugins/sosie/hooks/hooks.json', '${CLAUDE_PLUGIN_ROOT}', ['SessionStart', 'SessionEnd']],
      ['plugins/sosie/com.github.copilot/hooks/hooks.json', '${PLUGIN_ROOT}', ['SessionStart', 'Stop']],
    ]
    for (const [file, token, events] of files) {
      const hooks = json(file).hooks as Record<string, unknown>
      expect(Object.keys(hooks), file).toEqual(events)
      const commands = [...JSON.stringify(hooks).matchAll(/node \\"([^"\\]+)\\"/g)].map((m) => m[1]!)
      expect(commands, file).toHaveLength(events.length)
      for (const command of commands) {
        expect(command.startsWith(`${token}/hooks/`), command).toBe(true)
        expect(existsSync(join(hooksDir, command.slice(`${token}/hooks/`.length))), command).toBe(true)
      }
    }
  })

  describe('its hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-plugin-'))
    const data = mkdtempSync(join(tmpdir(), 'sosie-plugin-data-'))
    const before = { home: process.env.SOSIE_HOME, data: process.env.CLAUDE_PLUGIN_DATA }
    let hooks: Hooks
    beforeAll(async () => {
      process.env.SOSIE_HOME = home
      process.env.CLAUDE_PLUGIN_DATA = data
      hooks = await import(pathToFileURL(join(hooksDir, 'sosie.mjs')).href)
    })
    afterAll(() => {
      for (const [name, value] of [['SOSIE_HOME', before.home], ['CLAUDE_PLUGIN_DATA', before.data]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(home, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    })

    it('read the Sosies running as the core writes them', () => {
      expect(hooks.running()).toEqual([])
      writeRunning(home, { kind: 'postgres', address: 'postgres://localhost:7674/app', schema: { entities: [] }, passing: [] })
      expect(hooks.running()).toEqual([{ kind: 'postgres', address: 'postgres://localhost:7674/app' }])
      expect(hooks.cli()).toBe(`@sosie/cli@${cli}`)
    })

    it('find what to scan: a transcript and the folder beside it, or a Copilot CLI session by its id', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sosie-sessions-'))
      writeFileSync(join(dir, 'a.jsonl'), '')
      mkdirSync(join(dir, 'a'))
      expect(hooks.sessionFiles({ transcript_path: join(dir, 'a.jsonl') })).toEqual([join(dir, 'a.jsonl'), join(dir, 'a')])
      // Copilot CLI says where neither is: its session lives under $COPILOT_HOME/session-state.
      mkdirSync(join(dir, 'session-state', 's1'), { recursive: true })
      const copilot = { COPILOT_PLUGIN_DATA: data, COPILOT_HOME: dir }
      expect(hooks.sessionFiles({ session_id: 's1' }, copilot)).toEqual([join(dir, 'session-state', 's1')])
      expect(hooks.sessionFiles({ session_id: '../s1' }, copilot)).toEqual([])
      expect(hooks.sessionFiles({ session_id: 's1' }, {})).toEqual([])
      rmSync(dir, { recursive: true, force: true })
    })

    it('report each finding once, though a session scanned after each turn finds it again', () => {
      const { out } = hooks.scanPaths('v1')
      const finding = { file: '/t/v1.jsonl', line: 2, field: 'format:email' }
      hooks.keep(out, { transcript: '/t/v1.jsonl', findings: [finding] })
      expect(hooks.takeScans()).toEqual([{ transcript: '/t/v1.jsonl', findings: [finding] }])
      expect(hooks.takeScans()).toEqual([])
      const later = { file: '/t/v1.jsonl', line: 3, field: 'format:full_name' }
      hooks.keep(out, { transcript: '/t/v1.jsonl', findings: [finding, later] })
      expect(hooks.takeScans()).toEqual([{ transcript: '/t/v1.jsonl', findings: [later] }])
    })

    it('give the context where each assistant reads it, and none to a subagent', () => {
      const start = (event: Record<string, string>, env: Record<string, string> = {}) =>
        spawnSync(process.execPath, [join(hooksDir, 'session-start.mjs')], {
          input: JSON.stringify(event),
          encoding: 'utf8',
          env: { ...process.env, SOSIE_HOME: home, CLAUDE_PLUGIN_DATA: data, ...env },
        }).stdout
      const { out } = hooks.scanPaths('s2')
      hooks.keep(out, { transcript: '/t/s2.jsonl', findings: [{ file: '/t/s2.jsonl', line: 9, field: 'users.email' }] })
      // VS Code runs SessionStart hooks for a subagent too: it learns which Sosies run, and leaves the report.
      const subagent = JSON.parse(start({ hook_event_name: 'SubagentStart' }))
      expect(subagent.hookSpecificOutput.additionalContext).toMatch(/^Sosie is running/)
      expect(subagent.systemMessage).toBeUndefined()
      // Claude Code and VS Code read hookSpecificOutput; Copilot CLI a top-level additionalContext.
      const claude = JSON.parse(start({ hook_event_name: 'SessionStart' }))
      expect(claude.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart', additionalContext: expect.stringMatching(/line 9, from users.email/) })
      expect(claude.systemMessage).toMatch(/a real value/)
      const copilot = JSON.parse(start({ hook_event_name: 'SessionStart' }, { COPILOT_PLUGIN_DATA: data }))
      expect(Object.keys(copilot)).toEqual(['additionalContext'])
      expect(copilot.additionalContext).toMatch(/^Sosie is running/)
    })
  })
})
