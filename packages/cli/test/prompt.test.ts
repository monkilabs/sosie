import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { hiddenPrompt, prompt } from '../src/prompt.js'

/** A terminal: its input a TTY that goes raw when asked, and what it shows. */
function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() })
  const output = new PassThrough()
  const seen = { shown: '' }
  output.on('data', (d) => (seen.shown += d))
  return { input, output, seen }
}

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

  it('handles backspace, as \\u007f or \\b, and fails on empty input', async () => {
    const input = new PassThrough()
    const answer = hiddenPrompt('? ', input, new PassThrough())
    input.write('abx\u007fcy\b\r')
    expect(await answer).toBe('abc')
    const empty = new PassThrough()
    const nothing = hiddenPrompt('? ', empty, new PassThrough())
    empty.end()
    await expect(nothing).rejects.toThrow(new Error('No input.'))
  })

  it('turns raw mode on for a terminal, so it echoes nothing, and off once the line is read', async () => {
    const { input, output, seen } = terminal()
    const answer = hiddenPrompt('Connection string: ', input, output)
    expect(input.setRawMode.mock.calls).toEqual([[true]])
    input.write('postgres://kim:secret@db/app\r')
    expect(await answer).toBe('postgres://kim:secret@db/app')
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]])
    // The terminal echoed no Enter either: the newline is the prompt's.
    expect(seen.shown).toBe('Connection string: \n')
  })

  it('is cancelled by Ctrl+C, the one way out of raw mode, and leaves raw mode', async () => {
    const { input, output, seen } = terminal()
    const answer = hiddenPrompt('Connection string: ', input, output)
    input.write('postgres://kim:sec\u0003ret@db/app\r')
    await expect(answer).rejects.toThrow(new Error('Cancelled.'))
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(seen.shown).toBe('Connection string: \n')
  })
})

describe('the prompt', () => {
  it('leaves a terminal as it is, which echoes the line and its Enter', async () => {
    const { input, output, seen } = terminal()
    const answer = prompt('A name for it (shop): ', input, output)
    input.write('crm\n')
    expect(await answer).toBe('crm')
    expect(input.setRawMode).not.toHaveBeenCalled()
    expect(seen.shown).toBe('A name for it (shop): ')
  })

  it('ends the line itself when its input is no terminal, which echoes nothing', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let shown = ''
    output.on('data', (d) => (shown += d))
    const answer = prompt('A name for it (shop): ', input, output)
    input.write('crm\n')
    expect(await answer).toBe('crm')
    expect(shown).toBe('A name for it (shop): \n')
  })

  it('leaves what follows the line for the next question, as when answers are pasted together', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const first = prompt('? ', input, output)
    input.write('crm\nCRM_URL\nnext')
    expect(await first).toBe('crm')
    expect(await prompt('? ', input, output)).toBe('CRM_URL')
    input.write('\n')
    expect(await prompt('? ', input, output)).toBe('next')
  })

  it('reads a CRLF as one line end, so a pasted answer leaves no empty line for the next question to take as its default', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const first = prompt('? ', input, output)
    input.write('crm\r\nCRM_URL\r\n')
    expect(await first).toBe('crm')
    expect(await prompt('? ', input, output)).toBe('CRM_URL')
  })

  it('takes what came before input ends without a newline, and fails on an end with nothing', async () => {
    const input = new PassThrough()
    const answer = prompt('? ', input, new PassThrough())
    input.end('crm')
    expect(await answer).toBe('crm')
    const empty = new PassThrough()
    const nothing = prompt('? ', empty, new PassThrough())
    empty.end()
    await expect(nothing).rejects.toThrow(new Error('No input.'))
  })
})
