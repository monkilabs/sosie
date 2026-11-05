import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
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

interface Finding {
  file: string
  line: number
  field: string
}
interface Scan {
  transcript: string
  findings?: Finding[]
  failed?: string
}
interface Paths {
  out: string
  lock: string
  again: string
}
interface Hooks {
  running(): unknown[]
  cli(): string
  sessionFiles(event: Record<string, unknown>, env?: Record<string, string | undefined>): string[]
  pendingScans(): Scan[]
  reported(): void
  takeScans(): Scan[]
  addScan(out: string, scan: Scan): void
  scanPaths(session: string): Paths
  scanning(paths: Paths): boolean
  keep(file: string, result: unknown): void
}

const node = process.execPath
/** A hook run as the assistant runs it: its event on stdin, in an environment of the assistant's. */
const hook = (name: string, event: Record<string, unknown>, env: Record<string, string | undefined>) =>
  spawnSync(node, [join(hooksDir, name)], { input: JSON.stringify(event), encoding: 'utf8', env: env as NodeJS.ProcessEnv })
/** The environment, without what an assistant sets for its plugins. */
const bare = () => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of ['CLAUDE_PLUGIN_DATA', 'COPILOT_PLUGIN_DATA', 'COPILOT_HOME']) delete env[name]
  return env
}
const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !done(); i++) await sleep(50)
  expect(done(), what).toBe(true)
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
      // Run with --config-dir, Copilot CLI keeps its sessions where it keeps the plugin's data: <folder>/plugin-data/….
      const config = join(dir, 'config')
      mkdirSync(join(config, 'session-state', 's3'), { recursive: true })
      const configured = { COPILOT_PLUGIN_DATA: join(config, 'plugin-data', 'sosie', 'sosie'), COPILOT_HOME: join(dir, 'elsewhere') }
      expect(hooks.sessionFiles({ session_id: 's3' }, configured)).toEqual([join(config, 'session-state', 's3')])
      rmSync(dir, { recursive: true, force: true })
    })

    /** What scans found of one transcript, so a test reads its own results only. */
    const of = (transcript: string, scans: Scan[]) => scans.filter((s) => s.transcript === transcript)
    const email = (transcript: string, line: number) => ({ file: transcript, line, field: 'users.email' })

    it('report each finding once, though a session scanned after each turn finds it again', () => {
      const { out } = hooks.scanPaths('v1')
      const finding = { file: '/t/v1.jsonl', line: 2, field: 'format:email' }
      hooks.keep(out, { transcript: '/t/v1.jsonl', findings: [finding] })
      expect(of('/t/v1.jsonl', hooks.takeScans())).toEqual([{ transcript: '/t/v1.jsonl', findings: [finding] }])
      expect(of('/t/v1.jsonl', hooks.takeScans())).toEqual([])
      const later = { file: '/t/v1.jsonl', line: 3, field: 'format:full_name' }
      hooks.keep(out, { transcript: '/t/v1.jsonl', findings: [finding, later] })
      expect(of('/t/v1.jsonl', hooks.takeScans())).toEqual([{ transcript: '/t/v1.jsonl', findings: [later] }])
    })

    it('keep what a scan found when a later one fails, and say both; a clean scan ends the failure', () => {
      const t = '/t/m1.jsonl'
      const { out } = hooks.scanPaths('m1')
      hooks.addScan(out, { transcript: t, findings: [email(t, 1)] })
      hooks.addScan(out, { transcript: t, failed: 'npm error network' })
      expect(of(t, hooks.pendingScans())).toEqual([{ transcript: t, findings: [email(t, 1)], failed: 'npm error network' }])
      // Each finding once, however many scans found it.
      hooks.addScan(out, { transcript: t, findings: [email(t, 1), email(t, 2)] })
      expect(of(t, hooks.takeScans())).toEqual([{ transcript: t, findings: [email(t, 1), email(t, 2)] }])
      hooks.addScan(out, { transcript: t, failed: 'npm error network' })
      hooks.addScan(out, { transcript: t, findings: [] })
      expect(existsSync(out)).toBe(false)
    })

    it('mark nothing told until it is reported, and read past a seen file it cannot read', () => {
      const t = '/t/c1.jsonl'
      const { out } = hooks.scanPaths('c1')
      hooks.keep(out, { transcript: t, findings: [email(t, 1)] })
      writeFileSync(join(data, 'seen', 'c1.json'), '')
      expect(of(t, hooks.pendingScans())).toEqual([{ transcript: t, findings: [email(t, 1)] }])
      expect(existsSync(out)).toBe(true)
      // A scan that adds to the result meanwhile: it stays, for what it added.
      hooks.addScan(out, { transcript: t, findings: [email(t, 2)] })
      hooks.reported()
      expect(JSON.parse(readFileSync(join(data, 'seen', 'c1.json'), 'utf8'))).toEqual([`${t}:1:users.email`])
      expect(of(t, hooks.takeScans())).toEqual([{ transcript: t, findings: [email(t, 2)] }])
      expect(existsSync(out)).toBe(false)
    })

    it('tell a running scan by its lock: a live process of this user, written within the time a scan may take', () => {
      const paths = hooks.scanPaths('l1')
      expect(hooks.scanning(paths)).toBe(false)
      writeFileSync(paths.lock, String(process.pid))
      expect(hooks.scanning(paths)).toBe(true)
      // An empty lock is no pid: 0 would signal the whole process group.
      writeFileSync(paths.lock, '')
      expect(hooks.scanning(paths)).toBe(false)
      writeFileSync(paths.lock, String(spawnSync(node, ['-e', '']).pid))
      expect(hooks.scanning(paths)).toBe(false)
      // A killed scan's lock, its pid taken since by a live process.
      writeFileSync(paths.lock, String(process.pid))
      const old = new Date(Date.now() - 20 * 60_000)
      utimesSync(paths.lock, old, old)
      expect(hooks.scanning(paths)).toBe(false)
      rmSync(paths.lock)
    })

    it('give the context where each assistant reads it, and none to a subagent', () => {
      const own = mkdtempSync(join(tmpdir(), 'sosie-plugin-data-'))
      writeRunning(home, { kind: 'postgres', address: 'postgres://localhost:7674/app', schema: { entities: [] }, passing: [] })
      const start = (event: Record<string, string>, env: Record<string, string> = {}) =>
        hook('session-start.mjs', event, { ...bare(), SOSIE_HOME: home, CLAUDE_PLUGIN_DATA: own, ...env }).stdout
      const result = (session: string, scan: Scan) => {
        mkdirSync(join(own, 'scans'), { recursive: true })
        hooks.keep(join(own, 'scans', `${session}.json`), scan)
      }
      result('s2', { transcript: '/t/s2.jsonl', findings: [email('/t/s2.jsonl', 9)] })
      // VS Code runs SessionStart hooks for a subagent too: it learns which Sosies run, and leaves the report.
      const subagent = JSON.parse(start({ hook_event_name: 'SubagentStart' }))
      expect(subagent.hookSpecificOutput.additionalContext).toMatch(/^Sosie is running/)
      expect(subagent.hookSpecificOutput.additionalContext).not.toMatch(/real value/)
      expect(subagent.systemMessage).toBeUndefined()
      // Claude Code and VS Code read hookSpecificOutput; Copilot CLI a top-level additionalContext.
      const claude = JSON.parse(start({ hook_event_name: 'SessionStart' }))
      expect(claude.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart', additionalContext: expect.stringMatching(/line 9, from users.email/) })
      expect(claude.systemMessage).toMatch(/a real value/)
      expect(start({ hook_event_name: 'SessionStart' })).not.toMatch(/real value/)
      result('s3', { transcript: '/t/s3.jsonl', findings: [email('/t/s3.jsonl', 4)], failed: 'npm error network' })
      const copilot = JSON.parse(start({ hook_event_name: 'SessionStart' }, { COPILOT_PLUGIN_DATA: own }))
      expect(Object.keys(copilot)).toEqual(['additionalContext'])
      expect(copilot.additionalContext).toMatch(/^Sosie is running/)
      expect(copilot.additionalContext).toMatch(/line 4, from users.email/)
      expect(copilot.additionalContext).toMatch(/could not scan it again after a later turn: npm error network/)
      rmSync(own, { recursive: true, force: true })
    })

    // A stub npx on PATH stands for `npx @sosie/cli scan`: each run says what the files `<run>.out`, `.err` and
    // `.status` hold, and waits while `hold` is there.
    describe.skipIf(process.platform === 'win32')('scan a session in the background', () => {
      const vscode = mkdtempSync(join(tmpdir(), 'sosie-plugin-vscode-'))
      const stub = join(vscode, 'stub')
      const transcript = join(vscode, 'chat', 'v1.jsonl')
      // VS Code gives a plugin no data folder: the hooks keep theirs in $SOSIE_HOME/plugin.
      const env = { ...bare(), SOSIE_HOME: vscode, STUB: stub, PATH: `${join(vscode, 'bin')}${delimiter}${process.env.PATH}` }
      const scans = join(vscode, 'plugin', 'scans')
      const runs = () => (existsSync(join(stub, 'runs')) ? readFileSync(join(stub, 'runs'), 'utf8').trim().split('\n').length : 0)
      const stop = (event = 'Stop') => hook('session-end.mjs', { hook_event_name: event, session_id: 'v1', transcript_path: transcript }, env)
      const start = () => JSON.parse(hook('session-start.mjs', { hook_event_name: 'SessionStart' }, env).stdout).hookSpecificOutput.additionalContext
      const run = (n: number, { out = '', err = '', status = 0 }) => {
        writeFileSync(join(stub, `${n}.out`), out)
        writeFileSync(join(stub, `${n}.err`), err)
        writeFileSync(join(stub, `${n}.status`), String(status))
      }
      beforeAll(() => {
        for (const dir of ['bin', 'chat', 'stub', 'store']) mkdirSync(join(vscode, dir))
        writeFileSync(join(vscode, 'store', 'store.db'), '')
        writeFileSync(transcript, '{}\n')
        writeFileSync(
          join(vscode, 'bin', 'npx'),
          [
            '#!/bin/sh',
            'echo run >> "$STUB/runs"',
            `n=$(wc -l < "$STUB/runs" | tr -d ' ')`,
            'while [ -e "$STUB/hold" ]; do sleep 0.05; done',
            'cat "$STUB/$n.out"; cat "$STUB/$n.err" >&2',
            'exit $(cat "$STUB/$n.status")',
          ].join('\n'),
          { mode: 0o755 },
        )
      })
      afterAll(() => rmSync(vscode, { recursive: true, force: true }))

      it('not for a subagent; once at a time, and once more for a turn that ended meanwhile; keeping what each found', async () => {
        stop('SubagentStop')
        await sleep(300)
        expect(runs()).toBe(0)
        run(1, { out: `✗ ${transcript}:4  a real value from users.email\n  1 real value found in 1 file.\n`, status: 1 })
        run(2, { err: 'npm error code ENOTFOUND\nnpm error network\n', status: 2 })
        writeFileSync(join(stub, 'hold'), '')
        stop()
        await until(() => runs() === 1 && existsSync(join(scans, 'v1.lock')), 'the first scan runs')
        // A turn that ends while it runs asks for one more scan, and starts none.
        stop()
        expect(existsSync(join(scans, 'v1.again'))).toBe(true)
        await sleep(200)
        expect(runs()).toBe(1)
        rmSync(join(stub, 'hold'))
        await until(() => runs() === 2 && !existsSync(join(scans, 'v1.lock')), 'the second scan runs, and the lock goes')
        // The second scan failed: what the first found stays, and both are told.
        const context = start()
        expect(context).toMatch(new RegExp(`a real value in a session's transcript, ${transcript}:\\n  line 4, from users.email`))
        expect(context).toMatch(/could not scan it again after a later turn: npm error network/)
        expect(readdirOf(scans)).toEqual([])
      })

      it('say a scan failed when the CLI fails on its own, with exit 1 and nothing found', async () => {
        run(3, { err: '✗ Error: the store is locked\n    at main (cli.js:1:1)\n', status: 1 })
        stop()
        await until(() => runs() === 3 && !existsSync(join(scans, 'v1.lock')), 'the scan runs')
        expect(start()).toMatch(new RegExp(`could not scan a session's transcript, ${transcript}: Error: the store is locked`))
      })

      it('keep every finding of a scan that prints more than a megabyte of them', async () => {
        const lines = Array.from({ length: 12_000 }, (_, i) => `✗ ${transcript}:${i + 1}  a real value from users.email`).join('\n')
        run(4, { out: `${lines}\n  12000 real values found in 1 file.\n`, status: 1 })
        stop()
        await until(() => runs() === 4 && !existsSync(join(scans, 'v1.lock')), 'the scan runs')
        // Line 4 was told by the first scan: the other 11,999 are new.
        expect(start()).toMatch(/Sosie found 11999 real values in a session's transcript/)
      }, 20_000)

      it('say so when Copilot CLI names a session Sosie cannot find', () => {
        const copilot = join(vscode, 'copilot', 'plugin-data', 'sosie', 'sosie')
        const copilotEnv = { ...env, CLAUDE_PLUGIN_DATA: copilot, COPILOT_PLUGIN_DATA: copilot, COPILOT_HOME: join(vscode, 'nowhere') }
        hook('session-end.mjs', { hook_event_name: 'SessionEnd', session_id: 'c9' }, copilotEnv)
        const context = JSON.parse(hook('session-start.mjs', { hook_event_name: 'SessionStart' }, copilotEnv).stdout).additionalContext
        expect(context).toMatch(/could not scan a session's transcript, Copilot CLI's session c9: Sosie could not find where Copilot CLI keeps it/)
      })
    })
  })
})

function readdirOf(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}
