import { styleText } from 'node:util'

/** Lines for the terminal: what went well, what to know, what went wrong; a finding of scan's goes to stdout. */
export const ok = (text: string) => `  ${styleText('green', '✓', { stream: process.stdout })} ${text}`
export const warn = (text: string) => `  ${styleText('yellow', '!', { stream: process.stdout })} ${text}`
export const fail = (text: string) => `  ${styleText('red', '✗', { stream: process.stderr })} ${text}`
export const found = (text: string) => `  ${styleText('red', '✗', { stream: process.stdout })} ${text}`

/** Labels and what they say, in two columns: the second starts one space past the longest label, at 29 at least. */
export function columns(rows: [string, string][]): string[] {
  const width = Math.max(27, ...rows.map(([label]) => label.length + 1))
  return rows.map(([label, text]) => `  ${label.padEnd(width)}${text}`)
}
