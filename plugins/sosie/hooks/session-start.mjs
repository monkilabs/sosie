// The start of a session: tell the agent which Sosies run on this machine, or that the project uses Sosie and none
// runs; and report what the scan of a session's transcript found that no session has reported yet. Says nothing
// when there is nothing to say. Claude Code, Copilot CLI and VS Code run it.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { copilotCli, input, pendingScans, reported, running } from './sosie.mjs'

const event = await input()
// VS Code runs a session's start hooks when a subagent starts too: the report is the developer's, not a subagent's.
const subagent = event.hook_event_name === 'SubagentStart'
const cwd = event.cwd ?? process.cwd()
const context = []
const user = []

const sosies = running()
if (sosies.length) {
  context.push(
    `Sosie is running on this machine: ${sosies.map((s) => `${s.name} (${s.kind}) at ${s.address}`).join('; ')}. ` +
      'Every value it returns is a fake of a real one: read the sosie skill before you query. ' +
      'Read this data through these addresses or the sosie MCP tools, never from the real database or API.',
  )
} else if (existsSync(join(cwd, 'sosie.yml'))) {
  context.push(
    'This project uses Sosie (it has a sosie.yml), and no Sosie is running. Before you read its database or API, ' +
      "ask the developer to start Sosie in their own terminal, in the project's folder, with `npx @sosie/cli`. Never ask for a connection string or the credentials.",
  )
}

let found = false
for (const scan of subagent ? [] : pendingScans(cwd)) {
  if (scan.findings?.length) {
    found = true
    const n = scan.findings.length
    const lines = scan.findings
      .slice(0, 5)
      .map((f) => `  ${f.file === scan.transcript ? '' : `${f.file}, `}line ${f.line}, from ${f.field}`)
    if (n > 5) lines.push(`  and ${n - 5} more`)
    user.push(`Sosie found ${n === 1 ? 'a real value' : `${n} real values`} in a session's transcript, ${scan.transcript}:\n${lines.join('\n')}`)
  }
  if (scan.failed) {
    // A scan that fails keeps what earlier scans of the session found: its turns since are the ones not scanned.
    user.push(
      scan.findings?.length
        ? `Sosie could not scan it again after a later turn: ${scan.failed}`
        : `Sosie could not scan a session's transcript, ${scan.transcript}: ${scan.failed}`,
    )
  }
}
if (user.length) {
  context.push(
    `Tell the developer this first, in your own words, before anything else:\n${user.join('\n')}` +
      (found ? '\nDo not open those files to look: it would bring the real value into this session.' : ''),
  )
}

// What scans found is told once it is written out, not before: a start that fails on the way leaves it for the next.
const told = () => subagent || reported()
if (context.length) {
  const additionalContext = context.join('\n\n')
  // Copilot CLI reads the context at the top level; Claude Code and VS Code inside hookSpecificOutput.
  const output = copilotCli
    ? { additionalContext }
    : { ...(user.length && { systemMessage: user.join('\n') }), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
  process.stdout.write(JSON.stringify(output) + '\n', (error) => error || told())
} else told()
