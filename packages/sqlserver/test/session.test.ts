import { connect as dial, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Connection, Request, TYPES } from 'tedious'
import type { Faker } from '@sosie/core'
import { loadParser } from '../src/guard.js'
import { ENCRYPT, login7, OPTION, prelogin, versionBytes } from '../src/login.js'
import { buildCatalog } from '../src/schema.js'
import { PROC, readRpc, textParam, writeRpc, type Call } from '../src/rpc.js'
import { Session } from '../src/session.js'
import { readTypeInfo, textOf, TYPE } from '../src/types.js'
import { allHeaders, Cursor, Messages, PACKET, packets, STATUS, type Message } from '../src/tds.js'
import { DONE, done, ENV, envBytes, envText, loginAck, message, readTokens, TOKEN } from '../src/tokens.js'

beforeAll(() => loadParser())

const closing: (() => void)[] = []
afterEach(() => {
  for (const close of closing.splice(0)) close()
})

/**
 * A stand-in for SQL Server, as it answers what these tests send. A request whose text says "slow" is held until an
 * attention; an attention is acknowledged in a message of its own, after the reply to the request it stops.
 */
async function standIn(): Promise<{ port: number; requests: string[]; transactions: string[]; rpcs: Buffer[] }> {
  const requests: string[] = []
  /** Each batch's transaction descriptor, from its ALL_HEADERS, as hex. */
  const transactions: string[] = []
  /** Each RPC as it came. */
  const rpcs: Buffer[] = []
  const server = createServer((socket) => {
    socket.on('error', () => {})
    const messages = new Messages(socket)
    let held: (() => void) | undefined
    let prepared = ''
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
          if (m.payload.includes(Buffer.from('nowhere', 'utf16le'))) {
            // As Azure SQL refuses a login: its message names the server.
            socket.write(packets(PACKET.REPLY, Buffer.concat([message({ error: true, number: 40532, state: 1, severity: 20, text: "Cannot open server 'db-7.internal' requested by the login. The login failed.", server: 'db-7.internal', proc: '', line: 1 }), done(DONE.ERROR)])))
            continue
          }
          socket.write(packets(PACKET.REPLY, Buffer.concat([envText(ENV.DATABASE, 'app', 'master'), envBytes(ENV.COLLATION, Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34])), envText(ENV.LANGUAGE, 'us_english'), loginAck(0x74000004, 'Microsoft SQL Server', Buffer.from([16, 0, 0x0f, 0xa0])), envText(ENV.PACKET_SIZE, '4096', '4096'), done(0)])))
          continue
        }
        const text = m.type === PACKET.BATCH ? m.payload.subarray(m.payload.readUInt32LE(0)).toString('utf16le') : ''
        if (m.type === PACKET.BATCH) {
          requests.push(text)
          transactions.push(m.payload.subarray(10, 18).toString('hex'))
        }
        // A reset in a transaction, sent outside it: as a server answers a request whose descriptor is not its transaction's.
        if (m.status & (STATUS.RESET | STATUS.RESET_SKIP_TRAN) && m.payload.subarray(10, 18).equals(Buffer.alloc(8))) {
          socket.write(packets(PACKET.REPLY, Buffer.concat([message({ error: true, number: 3988, state: 1, severity: 16, text: 'New transaction is not allowed.', server: 'db1', proc: '', line: 1 }), done(DONE.ERROR)])))
          continue
        }
        const says = (word: string) => m.payload.includes(Buffer.from(word, 'utf16le'))
        const token = m.type === PACKET.RPC ? TOKEN.DONEPROC : TOKEN.DONE
        const proc = m.type === PACKET.RPC ? m.payload.readUInt16LE(m.payload.readUInt32LE(0) + 2) : undefined
        if (m.type === PACKET.RPC) rpcs.push(m.payload)
        if (proc === 11) {
          // sp_prepare: the statement kept, and its handle, 7, as the output parameter at ordinal 0.
          prepared = says('real@x.net') ? 'real@x.net' : 'fake@x.net'
          const handle = Buffer.concat([Buffer.from([TOKEN.RETURNVALUE, 0, 0, 7]), Buffer.from('@handle', 'utf16le'), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0x26, 4, 4, 7, 0, 0, 0])])
          socket.write(packets(PACKET.REPLY, Buffer.concat([handle, done(0, 0, TOKEN.DONEPROC)])))
          continue
        }
        if (proc === 12) {
          // sp_execute, answered with a message that quotes the prepared statement's value, as a syntax error's does.
          socket.write(packets(PACKET.REPLY, Buffer.concat([message({ error: true, number: 102, state: 1, severity: 15, text: `Incorrect syntax near '${prepared}'.`, server: 'db1', proc: '', line: 1 }), done(DONE.ERROR, 0, TOKEN.DONEPROC)])))
          continue
        }
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
  return { port, requests, transactions, rpcs }
}

const users = buildCatalog({
  tables: [{ schema: 'dbo', name: 'users', kind: 'U' }],
  columns: [
    { schema: 'dbo', table: 'users', name: 'email', type: 'nvarchar', maxLength: 240 },
    { schema: 'dbo', table: 'users', name: 'balance', type: 'decimal', maxLength: 9 },
  ],
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
async function sosie(upstream: number, { statementTimeout = 0, log = (_line: string) => {} } = {}): Promise<number> {
  const catalog = users
  type Scope = { back: Map<string, string>; lookup: (text: string, near?: unknown) => string | undefined; scrub: (t: string) => string }
  // A scope knows the real values it turned back, and those of the scope it was made from; scrub turns them into fakes.
  const request = (_sent?: string, from?: Scope): Scope => {
    const back = new Map(from?.back ?? [])
    return {
      back,
      lookup: (text, near) => {
        // Two fakes: an email, and a balance SqlClient would send as decimal(3,1).
        const real = near ? { 'fake@x.net': 'real@x.net', '12.5': '1234.56' }[text] : undefined
        if (real) back.set(real, text)
        return real
      },
      scrub: (t) => [...back].reduce((out, [real, fake]) => out.split(real).join(fake), t),
    }
  }
  const faker = { request, value: (v: string) => v, computed: (v: string) => v } as unknown as Faker
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
      log,
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
async function raw(port: number, database = 'app'): Promise<{ socket: Socket; messages: Messages; login: Message | null }> {
  const socket = dial(port, '127.0.0.1')
  closing.push(() => socket.destroy())
  await new Promise((resolve) => socket.once('connect', resolve))
  const messages = new Messages(socket)
  socket.write(packets(PACKET.PRELOGIN, prelogin([[OPTION.VERSION, versionBytes('16.0.0')], [OPTION.ENCRYPTION, Buffer.from([ENCRYPT.NOT_SUP])]])))
  await messages.next()
  socket.write(packets(PACKET.LOGIN7, login7({ userName: 'kim', password: 'x', serverName: '127.0.0.1', database, appName: 'test', features: new Map() })))
  const login = await messages.next()
  return { socket, messages, login }
}

const batch = (sql: string) => Buffer.concat([allHeaders(), Buffer.from(sql, 'utf16le')])
const dones = (m: Message | null) => [...readTokens(m!.payload)].flatMap((t) => (t.kind === 'done' ? [t.status] : []))

describe('logging in', () => {
  it('says the upstream refused it by the message’s number, its words in Sosie’s terminal: they may name the server', async () => {
    const up = await standIn()
    const lines: string[] = []
    const { login } = await raw(await sosie(up.port, { log: (line) => lines.push(line) }), 'nowhere')
    const refusal = [...readTokens(login!.payload)].find((t) => t.kind === 'message')
    expect(refusal).toMatchObject({ kind: 'message', error: true, number: 40532, server: 'Sosie' })
    expect(refusal?.kind === 'message' && refusal.text).not.toContain('db-7.internal')
    expect(lines.join('\n')).toContain("Cannot open server 'db-7.internal'")
  })
})

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

describe('prepared statements', () => {
  it('scrub a message at each execution as their prepare would: the real values it put in turned back into fakes', async () => {
    const up = await standIn()
    const c = await tedious(await sosie(up.port))
    const r = new Request("SELECT email FROM users WHERE email = N'fake@x.net' AND 1 = @x", () => {})
    r.addParameter('x', TYPES.Int)
    await new Promise<void>((resolve) => {
      r.once('prepared', () => resolve())
      c.prepare(r)
    })
    const error = await new Promise<string | undefined>((resolve) => {
      r.once('requestCompleted', () => resolve(undefined))
      r.callback = (e) => resolve(e?.message)
      c.execute(r, { x: 1 })
    })
    expect(error).toBe("Incorrect syntax near 'fake@x.net'.")
  })
})

describe('parameters', () => {
  it('go upstream in a type that holds the real value, where the one sized to the fake would cut it', async () => {
    const up = await standIn()
    const c = await tedious(await sosie(up.port))
    await new Promise<void>((resolve) => {
      const r = new Request('SELECT email FROM users WHERE balance = @b', () => resolve())
      // decimal(3,1), as SqlClient sizes 12.5.
      r.addParameter('b', TYPES.Decimal, 12.5, { precision: 3, scale: 1 })
      c.execSql(r)
    })
    const [{ params }] = readRpc(up.rpcs.at(-1)!, up.rpcs.at(-1)!.readUInt32LE(0)).calls as [Call]
    expect(textParam(params[1])).toBe('@b decimal(38,2)')
    expect(textOf(params[2]!.type, params[2]!.value.bytes!)).toBe('1234.56')
  })

  it('go upstream asking for the metadata a client asked to be spared, as browse mode’s is how Sosie reads a reply', async () => {
    const up = await standIn()
    const { socket, messages } = await raw(await sosie(up.port))
    const nvarchar = readTypeInfo(new Cursor(Buffer.from([TYPE.NVARCHAR, 0xff, 0xff, 0x09, 0x04, 0xd0, 0x00, 0x34])))
    const statement = { name: '', status: 0, type: nvarchar, value: { bytes: Buffer.from('SELECT 1 AS one', 'utf16le') } }
    // fNoMetaData (0x02), as SqlClient sends every RPC; fWithRecomp (0x01) is kept.
    socket.write(packets(PACKET.RPC, writeRpc({ headers: allHeaders(), calls: [{ proc: PROC.EXECUTESQL, options: 0x03, params: [statement] }], separators: [] })))
    await messages.next()
    expect(readRpc(up.rpcs.at(-1)!, up.rpcs.at(-1)!.readUInt32LE(0)).calls[0]!.options).toBe(0x01)
  })

  it('call no procedure of yours that is named like the catalog’s', async () => {
    const up = await standIn()
    const c = await tedious(await sosie(up.port))
    const before = up.rpcs.length
    const error = await new Promise<string | undefined>((resolve) => c.callProcedure(new Request('app.sp_tables', (e) => resolve(e?.message))))
    expect(error).toMatch(/^Sosie runs no procedures but the catalog's/)
    expect(up.rpcs.length).toBe(before)
  })

  it('answer a handle no driver sends, one byte long, with an error, and go on', async () => {
    const up = await standIn()
    const { socket, messages } = await raw(await sosie(up.port))
    const tinyint = readTypeInfo(new Cursor(Buffer.from([TYPE.INTN, 1])))
    const call = (proc: number) => packets(PACKET.RPC, writeRpc({ headers: allHeaders(), calls: [{ proc, options: 0, params: [{ name: '', status: 0, type: tinyint, value: { bytes: Buffer.from([7]) } }] }], separators: [] }))
    // sp_execute of no statement Sosie prepared is refused; sp_unprepare of one goes upstream, which answers it.
    socket.write(call(PROC.EXECUTE))
    expect([...readTokens((await messages.next())!.payload)].some((t) => t.kind === 'message' && t.error && t.number === 8179)).toBe(true)
    socket.write(call(PROC.UNPREPARE))
    expect(await messages.next()).not.toBeNull()
    // A transaction request too short to say what it is.
    socket.write(packets(PACKET.TRANSACTION, allHeaders()))
    expect([...readTokens((await messages.next())!.payload)].some((t) => t.kind === 'message' && t.error)).toBe(true)
    socket.write(packets(PACKET.BATCH, batch('SELECT 1 AS one')))
    expect(dones(await messages.next())).toEqual([DONE.FINAL])
  })

  it('read text, ntext and image as an RPC sends them, and turn them back', async () => {
    const up = await standIn()
    const c = await tedious(await sosie(up.port))
    const error = await new Promise<string | undefined>((resolve) => {
      const r = new Request('SELECT email FROM users WHERE email = @e', (e) => resolve(e?.message))
      r.addParameter('e', TYPES.NText, 'fake@x.net')
      c.execSql(r)
    })
    expect(error).toBeUndefined()
    const [{ params }] = readRpc(up.rpcs.at(-1)!, up.rpcs.at(-1)!.readUInt32LE(0)).calls as [Call]
    expect(params[2]!.value.bytes!.toString('utf16le')).toBe('real@x.net')
  })
})

describe('a pool’s reset', () => {
  const inTransaction = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  const resetting = (sql: string, transaction: Buffer) => packets(PACKET.BATCH, Buffer.concat([allHeaders(transaction), Buffer.from(sql, 'utf16le')]), 4096, STATUS.RESET_SKIP_TRAN)

  it('sets Sosie’s settings again in the transaction the request runs in', async () => {
    const up = await standIn()
    const { socket, messages } = await raw(await sosie(up.port))
    socket.write(resetting('SELECT 1 AS one', inTransaction))
    const reply = await messages.next()
    expect([...readTokens(reply!.payload)].some((t) => t.kind === 'message' && t.error)).toBe(false)
    expect(up.requests.slice(-2)).toEqual(['SET NO_BROWSETABLE ON; SET ROWCOUNT 101;', 'SELECT 1 AS one'])
    expect(up.transactions.at(-2)).toBe(inTransaction.toString('hex'))
  })

  it('runs no request whose settings could not be set again: it would run without browse mode', async () => {
    const up = await standIn()
    const { socket, messages } = await raw(await sosie(up.port))
    socket.write(resetting('SELECT 1 AS one', Buffer.alloc(8)))
    const reply = await messages.next()
    expect([...readTokens(reply!.payload)].some((t) => t.kind === 'message' && t.error)).toBe(true)
    expect(up.requests).not.toContain('SELECT 1 AS one')
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
