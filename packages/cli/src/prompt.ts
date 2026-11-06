type Input = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => void; unshift?: (chunk: string) => void }

/** Ask for a value without echoing it, so it never shows on screen or in a recording. */
export function hiddenPrompt(question: string, input: Input, output: NodeJS.WritableStream): Promise<string> {
  return ask(question, input, output, true)
}

/** Ask for a line, as the terminal echoes it. */
export function prompt(question: string, input: Input, output: NodeJS.WritableStream): Promise<string> {
  return ask(question, input, output, false)
}

function ask(question: string, input: Input, output: NodeJS.WritableStream, hidden: boolean): Promise<string> {
  output.write(question)
  return new Promise((resolve, reject) => {
    let value = ''
    // Raw, a terminal echoes nothing, and each key comes as it is typed; without it, a line comes once it is whole.
    const raw = hidden && !!input.isTTY && typeof input.setRawMode === 'function'
    if (raw) input.setRawMode!(true)
    input.setEncoding('utf8')
    const finish = (error?: Error, rest = '') => {
      input.off('data', onData)
      input.off('end', onEnd)
      if (raw) input.setRawMode!(false)
      input.pause()
      // What came after the line is the next question's: an answer pasted with others, or typed ahead.
      if (rest) input.unshift?.(rest)
      if (hidden || !input.isTTY) output.write('\n')
      if (error) reject(error)
      else resolve(value.trim())
    }
    const onEnd = () => finish(value ? undefined : new Error('No input.'))
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk)
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!
        if (ch === '\r' || ch === '\n') return finish(undefined, text.slice(i + (ch === '\r' && text[i + 1] === '\n' ? 2 : 1)))
        if (ch === '\u0003') return finish(new Error('Cancelled.'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    input.on('data', onData)
    input.on('end', onEnd)
    input.resume()
  })
}
