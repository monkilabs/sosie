// Claude Code's SessionEnd: scan this session's transcript for real values that passed through Sosie.
//
// A plugin's SessionEnd hook gets 1.5 seconds and its output is not shown, while a scan can take longer. So the scan
// runs in a process of its own, and the next session to start reports what it found.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hasStore, input, root, scanFile } from './sosie.mjs'

const { session_id: session, transcript_path: transcript } = await input()
const out = scanFile(session ?? Date.now())
if (transcript && existsSync(transcript) && hasStore() && out) {
  spawn(process.execPath, [join(root, 'hooks', 'scan.mjs'), transcript, out], { detached: true, stdio: 'ignore' }).unref()
}
