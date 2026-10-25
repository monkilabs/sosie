import { createReadStream, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ScanIndex } from './store.js'
import { MAX_WORDS, tokens } from './text.js'

export interface Finding {
  file: string
  line: number
  /** The domain of the real value found: 'users.email', 'format:email'. Never the value. */
  domain: string
}

export interface ScanResult {
  findings: Finding[]
  files: number
}

/** Folders never worth scanning. */
const SKIP = new Set(['.git', 'node_modules'])

/**
 * Search files and folders for real values that passed through Sosie. Each
 * line is split into words, and every run of one to four words is compared,
 * by keyed hash, with the real values in the stores. A run that is also a fake
 * is not counted: it is what the agent was shown.
 */
export async function scan(paths: string[], indexes: ScanIndex[]): Promise<ScanResult> {
  const result: ScanResult = { findings: [], files: 0 }
  for (const path of paths) await visit(path, indexes, result)
  return result
}

async function visit(path: string, indexes: ScanIndex[], result: ScanResult): Promise<void> {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && SKIP.has(entry.name)) continue
      if (entry.isDirectory() || entry.isFile()) await visit(join(path, entry.name), indexes, result)
    }
    return
  }
  if (!stat.isFile() || binary(path)) return
  result.files++
  let line = 0
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const text of lines) {
    line++
    const domain = findIn(text, indexes)
    if (domain) result.findings.push({ file: path, line, domain })
  }
}

/** JSON string escapes decoded, so a value after a \n in a transcript is a word of its own. */
function unescape(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) =>
    e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: '\n', t: '\t', r: '\r', b: ' ', f: ' ' } as Record<string, string>)[e] ?? e,
  )
}

/** The domain of the first real value in a line of text. */
export function findIn(text: string, indexes: ScanIndex[]): string | undefined {
  const words = tokens(unescape(text))
  for (let i = 0; i < words.length; i++) {
    let run = ''
    for (let n = 0; n < MAX_WORDS && i + n < words.length; n++) {
      run = n === 0 ? words[i]! : `${run} ${words[i + n]}`
      if (run.length < 4) continue
      for (const index of indexes) {
        const domain = index.find(run)
        if (domain) return domain
      }
    }
  }
  return undefined
}

function binary(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(8192)
    const read = readSync(fd, head, 0, head.length, 0)
    return head.subarray(0, read).includes(0)
  } finally {
    closeSync(fd)
  }
}
