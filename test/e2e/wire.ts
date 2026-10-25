import { connect } from 'node:net'

/** A frontend message: its code, length and body. */
export function typed(code: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(code)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

/**
 * Talk to an endpoint message by message, as a client a driver library hides:
 * start up, send the messages, and return the codes of what came back after
 * start-up, until the last ReadyForQuery.
 */
export function raw(port: number, messages: Buffer[], timeout = 3000): Promise<string[]> {
  const params = Buffer.from('user\0kim\0database\0app\0\0')
  const startup = Buffer.alloc(8)
  startup.writeInt32BE(8 + params.length)
  startup.writeInt32BE(196608, 4)
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.concat([startup, params])))
    let buffer = Buffer.alloc(0)
    let started = false
    const codes: string[] = []
    const ready = () => codes.filter((c) => c === 'Z').length
    const expected = messages.filter((m) => m[0] === 0x53 || m[0] === 0x46 || m[0] === 0x51).length
    const timer = setTimeout(() => (socket.destroy(), reject(new Error(`no answer: ${codes.join(' ')}`))), timeout)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer])
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        const code = String.fromCharCode(buffer[0]!)
        buffer = buffer.subarray(1 + buffer.readInt32BE(1))
        if (!started) {
          if (code === 'Z') {
            started = true
            socket.write(Buffer.concat(messages))
          }
          continue
        }
        if (code === 'E' || code === 'Z') codes.push(code)
        // A Query sent before Sync after an error is discarded: one ReadyForQuery per F and S.
        if (ready() >= expected - messages.filter((m) => m[0] === 0x51).length) {
          clearTimeout(timer)
          socket.end()
          resolve(codes)
        }
      }
    })
    socket.on('error', reject)
  })
}
