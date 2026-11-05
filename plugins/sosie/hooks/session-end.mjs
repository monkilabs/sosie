// The end of a session, or of a turn: scan what the session's transcript holds for real values that passed through
// Sosie. Claude Code and Copilot CLI run it when a session ends; VS Code, which has no such event, each time the agent
// stops, so the scan runs at most once at a time per session, and once more when a turn ended while it ran.
//
// A hook here gets little time (1.5 seconds in Claude Code) and its output is not shown, while a scan can take
// longer. So the scan runs in a process of its own, and the next session to start reports what it found.
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { addScan, copilotCli, hasStore, input, root, scanning, scanPaths, sessionFiles } from './sosie.mjs'

const event = await input()
// A subagent's turn ends inside its session: the session's own stop scans what it wrote.
const subagent = event.hook_event_name === 'SubagentStop'
if (!subagent && hasStore()) {
  const paths = sessionFiles(event)
  const scan = scanPaths(event.session_id ?? Date.now())
  if (paths.length) {
    // The lock is taken here, at once, so two turns that end together start one scan: the other asks it for once more.
    const take = () => {
      try {
        writeFileSync(scan.lock, String(process.pid), { flag: 'wx', mode: 0o600 })
        return true
      } catch {
        return false
      }
    }
    // A lock no scan holds any more (one that was killed) is taken over.
    const taken = take() || (!scanning(scan) && (rmSync(scan.lock, { force: true }), take()))
    if (!taken) writeFileSync(scan.again, '')
    else {
      // The scan keeps the session's project: the next session there reports it, not one in another project.
      const env = { ...process.env, ...(event.cwd && { SOSIE_SCAN_PROJECT: resolve(event.cwd) }) }
      const child = spawn(process.execPath, [join(root, 'hooks', 'scan.mjs'), scan.out, ...paths], { detached: true, stdio: 'ignore', windowsHide: true, env })
      // The lock is the scan's from here on, before this hook ends: a turn that ends next finds it running.
      writeFileSync(scan.lock, String(child.pid), { mode: 0o600 })
      child.unref()
    }
  } else if (copilotCli && event.session_id) {
    // Copilot CLI names only the session: one Sosie cannot find is said, not skipped.
    addScan(scan.out, {
      transcript: `Copilot CLI's session ${event.session_id}`,
      failed: 'Sosie could not find where Copilot CLI keeps it',
      ...(event.cwd && { project: resolve(event.cwd) }),
    })
  }
}
