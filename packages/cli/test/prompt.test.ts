import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { hiddenPrompt } from '../src/prompt.js'

describe('the hidden prompt', () => {
  it('reads a line without echoing it', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let shown = ''
    output.on('data', (d) => (shown += d))
    const answer = hiddenPrompt('Connection string: ', input, output)
    input.write('postgres://kim:secret@db/app\n')
    expect(await answer).toBe('postgres://kim:secret@db/app')
    expect(shown).toBe('Connection string: \n')
  })

  it('handles backspace, and fails on empty input', async () => {
    const input = new PassThrough()
    const answer = hiddenPrompt('? ', input, new PassThrough())
    input.write('abx\u007fc\r')
    expect(await answer).toBe('abc')
    const empty = new PassThrough()
    const nothing = hiddenPrompt('? ', empty, new PassThrough())
    empty.end()
    await expect(nothing).rejects.toThrow('No input.')
  })
})
