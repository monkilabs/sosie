/** Ask for a value without echoing it, so it never shows on screen or in a recording. */
export function hiddenPrompt(question: string, input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => void }, output: NodeJS.WritableStream): Promise<string> {
  output.write(question)
  return new Promise((resolve, reject) => {
    let value = ''
    const raw = !!input.isTTY && typeof input.setRawMode === 'function'
    if (raw) input.setRawMode!(true)
    input.setEncoding('utf8')
    const finish = (error?: Error) => {
      input.off('data', onData)
      input.off('end', onEnd)
      if (raw) input.setRawMode!(false)
      input.pause()
      output.write('\n')
      if (error) reject(error)
      else resolve(value.trim())
    }
    const onEnd = () => finish(value ? undefined : new Error('No input.'))
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish()
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
