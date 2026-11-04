// The end of a session, or of a turn: scan what the session's transcript holds for real values that passed through
// Sosie. Claude Code and Copilot CLI run it when a session ends; VS Code, which has no such event, each time the agent
// stops, so the scan runs at most once at a time per session, and once more when a turn ended while it ran.
//
// A hook here gets little time (1.5 seconds in Claude Code) and its output is not shown, while a scan can take
// longer. So the scan runs in a process of its own, and the next session to start reports what it found.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasStore, input, root, scanning, scanPaths, sessionFiles } from './sosie.mjs'

const event = await input()
// A subagent's turn ends inside its session: the session's own stop scans what it wrote.
const subagent = event.hook_event_name === 'SubagentStop'
const paths = sessionFiles(event)
if (!subagent && paths.length && hasStore()) {
  const scan = scanPaths(event.session_id ?? Date.now())
  if (scanning(scan)) writeFileSync(scan.again, '')
  else spawn(process.execPath, [join(root, 'hooks', 'scan.mjs'), scan.out, ...paths], { detached: true, stdio: 'ignore' }).unref()
}
