import { connect as dial, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Connection, Request, TYPES } from 'tedious'
import type { Faker } from '@sosie/core'
import { loadParser } from '../src/guard.js'
import { ENCRYPT, login7, OPTION, prelogin, versionBytes } from '../src/login.js'
import { buildCatalog } from '../src/schema.js'
import { Session } from '../src/session.js'
import { allHeaders, Messages, PACKET, packets, STATUS, type Message } from '../src/tds.js'
import { DONE, done, ENV, envBytes, envText, loginAck, readTokens, TOKEN } from '../src/tokens.js'

beforeAll(() => loadParser())

const closing: (() => void)[] = []
afterEach(() => {
  for (const close of closing.splice(0)) close()
})

/**
 * A stand-in for SQL Server, as it answers what these tests send. A request whose text says "slow" is held until an
 * attention; an attention is acknowledged in a message of its own, after the reply to the request it stops.
 */
async function standIn(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = []
  const server = createServer((socket) => {
    socket.on('error', () => {})
    const messages = new Messages(socket)
    let held: (() => void) | undefined
    const attention = () => {
      held?.()
      held = undefined
      socket.write(packets(PACKET.REPLY, done(DONE.ATTN)))
    }
    messages.attention = attention
    void (async () => {
      for (;;) {
        const m = await messages.next().catch(() => null)
        if (!m) return
        if (m.type === PACKET.PRELOGIN) {
          socket.write(packets(PACKET.REPLY, prelogin([[OPTION.VERSION, versionBytes('16.0.4000')], [OPTION.ENCRYPTION, Buffer.from([ENCRYPT.NOT_SUP])], [OPTION.INSTANCE, Buffer.from([0])], [OPTION.THREADID, Buffer.alloc(0)], [OPTION.MARS, Buffer.from([0])]])))
          continue
        }
        if (m.type === PACKET.LOGIN7) {
          socket.write(packets(PACKET.REPLY, Buffer.concat([envText(ENV.DATABASE, 'app', 'master'), envBytes(ENV.COLLATION, Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34])), envText(ENV.LANGUAGE, 'us_english'), loginAck(0x74000004, 'Microsoft SQL Server', Buffer.from([16, 0, 0x0f, 0xa0])), envText(ENV.PACKET_SIZE, '4096', '4096'), done(0)])))
          continue
        }
        const text = m.type === PACKET.BATCH ? m.payload.subarray(m.payload.readUInt32LE(0)).toString('utf16le') : ''
        if (m.type === PACKET.BATCH) requests.push(text)
        const says = (word: string) => m.payload.includes(Buffer.from(word, 'utf16le'))
        const token = m.type === PACKET.RPC ? TOKEN.DONEPROC : TOKEN.DONE
        if (says('many')) {
          // One int column, many rows: a reply a client reads while it comes.
          const column = Buffer.concat([Buffer.from([TOKEN.COLMETADATA, 1, 0, 0, 0, 0, 0, 0, 0, 0x38, 4]), Buffer.from('many', 'utf16le')])
          const rows = Buffer.concat(Array.from({ length: 3000 }, (_, i) => Buffer.from([TOKEN.ROW, i & 0xff, 0, 0, 0])))
          socket.write(packets(PACKET.REPLY, Buffer.concat([column, rows, done(DONE.COUNT, 3000, TOKEN.DONEINPROC), Buffer.from([TOKEN.RETURNSTATUS, 0, 0, 0, 0]), done(0, 0, token)])))
        } else if (says('slow')) {
          // A USE before it has run: the session is in that database, whether or not what follows is stopped.
          const moved = says('USE other') ? envText(ENV.DATABASE, 'other', 'app') : Buffer.alloc(0)
          held = () => socket.write(packets(PACKET.REPLY, Buffer.concat([moved, done(DONE.ERROR, 0, token)])))
        } else {
          socket.write(packets(PACKET.REPLY, done(0, 0, token)))
        }
        if (m.attended) attention()
      }
    })()
  })
  const port = await listen(server)
  return { port, requests }
}

const users = buildCatalog({
  tables: [{ schema: 'dbo', name: 'users', kind: 'U' }],
  columns: [{ schema: 'dbo', table: 'users', name: 'email', type: 'nvarchar', maxLength: 240 }],
  primary: [],
  unique: [{ schema: 'dbo', table: 'users', column: 'email' }],
  references: [],
  functions: [],
  login: { defaultSchema: 'dbo', database: 'app', admin: false, writable: false, azure: false },
})

/**
 * Sosie in front of the stand-in, every value passed as it is: these tests are about the protocol. Its one fake,
 * fake@x.net, stands for real@x.net in users.email's domain, and for nothing outside it.
 */
async function sosie(upstream: number, { statementTimeout = 0 } = {}): Promise<number> {
  const catalog = users
  const scope = { lookup: (text: string, near?: unknown) => (text === 'fake@x.net' && near ? 'real@x.net' : undefined), scrub: (t: string) => t }
  const faker = { request: () => scope, value: (v: string) => v, computed: (v: string) => v } as unknown as Faker
  const server = createServer((socket) => {
    socket.on('error', () => {})
    void new Session(socket, {
      target: { host: '127.0.0.1', port: upstream, database: 'app', user: 'u', password: 'p', encrypt: 'off', verify: false, readOnlyIntent: false },
      catalog,
      faker,
      maxRows: 100,
      statementTimeout,
      secureContext: () => {
        throw new Error('no TLS here')
      },
      version: '16.0.4000',
      log: () => {},
    }).run()
  })
  return listen(server)
}

function listen(server: Server): Promise<number> {
  closing.push(() => server.close())
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function tedious(port: number): Promise<Connection> {
  const c = new Connection({
    server: '127.0.0.1',
    authentication: { type: 'default', options: { userName: 'kim', password: 'x' } },
    options: { port, encrypt: false, database: 'app', requestTimeout: 300, cancelTimeout: 2000, trustServerCertificate: true },
  })
  closing.push(() => c.close())
  return new Promise((resolve, reject) => {
    c.on('connect', (e) => (e ? reject(e) : resolve(c)))
    c.on('error', () => {})
    c.connect()
  })
}

function run(c: Connection, sql: string): Promise<string | undefined> {
  return new Promise((resolve) => c.execSqlBatch(new Request(sql, (e) => resolve(e ? `${(e as { code?: string }).code}: ${e.message}` : undefined))))
}

/** A client of TDS's own, which sends what drivers do not: an attention with its request, an ignored message. */
async function raw(port: number): Promise<{ socket: Socket; messages: Messages }> {
  const socket = dial(port, '127.0.0.1')
  closing.push(() => socket.destroy())
  await new Promise((resolve) => socket.once('connect', resolve))
  const messages = new Messages(socket)
  socket.write(packets(PACKET.PRELOGIN, prelogin([[OPTION.VERSION, versionBytes('16.0.0')], [OPTION.ENCRYPTION, Buffer.from([ENCRYPT.NOT_SUP])]])))
  await messages.next()
  socket.write(packets(PACKET.LOGIN7, login7({ userName: 'kim', password: 'x', serverName: '127.0.0.1', database: 'app', appName: 'test', features: new Map() })))
  await messages.next()
  return { socket, messages }
}

const batch = (sql: string) => Buffer.concat([allHeaders(), Buffer.from(sql, 'utf16le')])
const dones = (m: Message | null) => [...readTokens(m!.payload)].flatMap((t) => (t.kind === 'done' ? [t.status] : []))

describe('the session’s database', () => {
  it('moves with a USE in a statement Sosie stopped at its time limit, as the server’s does', async () => {
    const up = await standIn()
    const { socket, messages } = await raw(await sosie(up.port, { statementTimeout: 200 }))
    socket.write(packets(PACKET.BATCH, batch('USE other; SELECT 1 AS slow')))
    expect(dones(await messages.next())).toEqual([DONE.ERROR])
    // In other, users is not the table Sosie read: a fake of app's is not turned back there.
    socket.write(packets(PACKET.BATCH, batch("SELECT email FROM users WHERE email = N'fake@x.net'")))
    await messages.next()
    expect(up.requests.at(-1)).toBe("SELECT email FROM users WHERE email = N'fake@x.net'")
  })
})

describe('cancelling', () => {
  it('answers a request the client stops with its reply, then the acknowledgment in a message of its own', async () => {
    const up = await standIn()
    const c = await tedious(await sosie(up.port))
    // tedious stops the statement at its requestTimeout, and waits for the reply and then the acknowledgment.
    expect(await run(c, 'SELECT 1 AS slow')).toMatch(/^ETIMEOUT: Timeout: Request failed to complete/)
    expect(await run(c, 'SELECT 1 AS one')).toBeUndefined()
  })

  it('acknowledges a cancel that comes after the reply with a DONE, after an RPC too', async () => {
    const up = await standIn()
    const c = await tedious(await sosie(up.port))
    const cancelled = await new Promise<string | undefined>((resolve) => {
      const r = new Request('SELECT 1 AS many WHERE @x = 1', (e) => resolve(e ? ((e as { code?: string }).code ?? e.message) : undefined))
      r.addParameter('x', TYPES.Int, 1)
      let rows = 0
      r.on('row', () => {
        if (rows++ === 0) r.cancel()
      })
      c.execSql(r)
    })
    expect(cancelled).toBe('ECANCEL')
    expect(await run(c, 'SELECT 1 AS one')).toBeUndefined()
  })

  it('answers an attention that comes with its request after the request’s reply, never before', async () => {
    const up = await standIn()
    const { socket, messages } = await raw(await sosie(up.port))
    socket.write(Buffer.concat([packets(PACKET.BATCH, batch('SELECT 1 AS one')), packets(PACKET.ATTENTION, Buffer.alloc(0))]))
    const reply = await messages.next()
    const ack = await messages.next()
    expect(dones(reply).some((s) => s & DONE.ATTN)).toBe(false)
    expect(dones(ack)).toEqual([DONE.ATTN])
    expect([...readTokens(ack!.payload)][0]).toMatchObject({ kind: 'done', token: TOKEN.DONE })
  })

  it('runs nothing of a message the client ignores, as it stopped sending it, and answers it', async () => {
    const up = await standIn()
    const { socket, messages } = await raw(await sosie(up.port))
    const before = up.requests.length
    socket.write(packets(PACKET.BATCH, batch('SELECT 1 AS ignored'), 4096, STATUS.IGNORE))
    expect(dones(await messages.next())).toEqual([DONE.FINAL])
    socket.write(packets(PACKET.BATCH, batch('SELECT 1 AS one')))
    await messages.next()
    expect(up.requests.slice(before)).toEqual(['SELECT 1 AS one'])
  })
})
