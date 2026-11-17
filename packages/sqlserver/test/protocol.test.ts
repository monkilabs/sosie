import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { endpointCertificate } from '../src/certificate.js'
import { FEATURE, login7, readLogin7, TDS } from '../src/login.js'
import { fits, maxOf, readDeclarations, readRpc, widen, writeRpc } from '../src/rpc.js'
import { allHeaders, Cursor, Messages, packets, PACKET } from '../src/tds.js'
import { readTokens, row, colMetadata, done, message, order, DONE, TOKEN, COLINFO } from '../src/tokens.js'
import { rewriteReply } from '../src/results.js'
import { buildCatalog } from '../src/schema.js'
import type { Faker } from '@sosie/core'
import { readTypeInfo, TYPE } from '../src/types.js'
import { PassThrough } from 'node:stream'

describe('packets and messages', () => {
  it('splits a message into packets of the session’s size, and reads it back whole', async () => {
    const stream = new PassThrough()
    const messages = new Messages(stream)
    const payload = Buffer.alloc(10_000, 7)
    stream.write(packets(PACKET.BATCH, payload, 4096))
    const message = await messages.next()
    expect(message!.type).toBe(PACKET.BATCH)
    expect(message!.payload).toEqual(payload)
  })

  it('tells an attention at once, between messages', async () => {
    const stream = new PassThrough()
    const messages = new Messages(stream)
    let told = 0
    messages.attention = () => told++
    stream.write(packets(PACKET.ATTENTION, Buffer.alloc(0)))
    await new Promise((resolve) => setImmediate(resolve))
    expect(told).toBe(1)
  })
})

describe('LOGIN7', () => {
  it('writes a login a server reads, password and features and all', () => {
    const payload = login7({ userName: 'sosie', password: 'sëcret', serverName: 'db', database: 'app', appName: 'test', features: new Map([[FEATURE.UTF8, Buffer.alloc(0)]]) })
    const read = readLogin7(payload)
    expect(read).toMatchObject({ userName: 'sosie', password: 'sëcret', serverName: 'db', database: 'app', appName: 'test', tdsVersion: TDS.V7_4 })
    expect(read.features.has(FEATURE.UTF8)).toBe(true)
  })
})

describe('RPC', () => {
  it('reads a call and writes it back as it came', () => {
    const nvarchar = Buffer.from([TYPE.NVARCHAR, 0x40, 0x1f, 0x09, 0x04, 0xd0, 0x00, 0x34])
    const text = (s: string) => Buffer.concat([Buffer.from([Buffer.byteLength(s, 'utf16le') & 0xff, Buffer.byteLength(s, 'utf16le') >> 8]), Buffer.from(s, 'utf16le')])
    const payload = Buffer.concat([
      allHeaders(),
      Buffer.from([0xff, 0xff, 10, 0, 0, 0]),
      Buffer.from([0, 0]), nvarchar, text('SELECT @p1'),
      Buffer.from([0, 0]), nvarchar, text('@p1 int'),
      Buffer.from([3, ...Buffer.from('@p1', 'utf16le'), 0, TYPE.INTN, 4, 4, 42, 0, 0, 0]),
    ])
    const rpc = readRpc(payload, 22)
    expect(rpc.calls).toHaveLength(1)
    expect(rpc.calls[0]!.proc).toBe(10)
    expect(rpc.calls[0]!.params.map((p) => p.name)).toEqual(['', '', '@p1'])
    expect(writeRpc(rpc)).toEqual(payload)
  })

  it('reads a declaration, and widens a parameter whose real value is longer than its type', () => {
    const declared = readDeclarations('@p0 nvarchar(5),@p1 decimal(10, 2), @p2 int OUTPUT')
    expect(declared.map((d) => [d.name, d.type, d.output])).toEqual([
      ['@p0', 'nvarchar(5)', false],
      ['@p1', 'decimal(10, 2)', false],
      ['@p2', 'int', true],
    ])
    expect(widen('@p0 nvarchar(5),@p1 decimal(10, 2)', declared, new Set(['@p0']))).toBe('@p0 nvarchar(max),@p1 decimal(10, 2)')
    const five = readTypeInfo(new Cursor(Buffer.from([TYPE.NVARCHAR, 10, 0, 0x09, 0x04, 0xd0, 0x00, 0x34])))
    expect(fits(five, 'abcde')).toBe(true)
    expect(fits(five, 'abcdef')).toBe(false)
    expect(maxOf(five).layout).toBe('plp')
  })
})

describe('tokens', () => {
  it('writes the tokens a reply needs, and reads them back', () => {
    const int = readTypeInfo(new Cursor(Buffer.from([TYPE.INTN, 4])))
    const column = { userType: 0, flags: 1, type: int, name: 'n', raw: Buffer.concat([Buffer.alloc(4), Buffer.from([1, 0]), int.raw, Buffer.from([1, 0x6e, 0])]) }
    const payload = Buffer.concat([
      colMetadata([column]),
      row([column], [{ bytes: Buffer.from([5, 0, 0, 0]) }]),
      message({ error: false, number: 50000, state: 1, severity: 0, text: 'a note', server: 'Sosie', proc: '', line: 1 }),
      done(DONE.COUNT, 1),
    ])
    const tokens = [...readTokens(payload)]
    expect(tokens.map((t) => t.kind)).toEqual(['colmetadata', 'row', 'message', 'done'])
    expect(tokens[1]).toMatchObject({ values: [{ bytes: Buffer.from([5, 0, 0, 0]) }] })
    expect(tokens[2]).toMatchObject({ text: 'a note', server: 'Sosie' })
  })
})

describe('the endpoint’s certificate', () => {
  it('is signed by Sosie’s own CA, names the hosts clients reach, and is kept for the next start', () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-tls-'))
    try {
      const first = endpointCertificate(home, ['db.local'])
      const ca = new X509Certificate(first.ca)
      const cert = new X509Certificate(first.cert)
      expect(ca.ca).toBe(true)
      expect(cert.verify(ca.publicKey)).toBe(true)
      expect(cert.checkHost('localhost')).toBe('localhost')
      expect(cert.checkHost('db.local')).toBe('db.local')
      expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1')
      expect(cert.checkIP('::1')).toBeDefined()
      expect(statSync(join(home, 'tls', 'ca.key')).mode & 0o077).toBe(0)
      const again = endpointCertificate(home, ['db.local'])
      expect(again.cert).toBe(first.cert)
      expect(readFileSync(first.caPath, 'utf8')).toBe(first.ca)
      // A host it does not name yet: a new certificate, from the same CA.
      const other = endpointCertificate(home, ['other.local'])
      expect(other.cert).not.toBe(first.cert)
      expect(other.ca).toBe(first.ca)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('a reply as the client gets it', () => {
  const int = readTypeInfo(new Cursor(Buffer.from([TYPE.INTN, 4])))
  const nvarchar = readTypeInfo(new Cursor(Buffer.from([TYPE.NVARCHAR, 80, 0, 0x09, 0x04, 0xd0, 0x00, 0x34])))
  const entry = (name: string, type: typeof int) => ({ userType: 0, flags: 1, type, name, raw: Buffer.concat([Buffer.alloc(4), Buffer.from([1, 0]), type.raw, Buffer.from([name.length]), Buffer.from(name, 'utf16le')]) })
  const catalog = buildCatalog({
    tables: [{ schema: 'dbo', name: 'users', kind: 'U' }],
    columns: [
      { schema: 'dbo', table: 'users', name: 'id', type: 'int', maxLength: 4 },
      { schema: 'dbo', table: 'users', name: 'email', type: 'nvarchar', maxLength: 80 },
    ],
    primary: [{ schema: 'dbo', table: 'users', column: 'id' }],
    unique: [],
    references: [],
    functions: [],
    login: { defaultSchema: 'dbo', database: 'app', admin: false, writable: false, azure: false },
  })
  const faker = { value: (v: string) => `fake ${v}`, computed: (v: string) => `computed ${v}` } as unknown as Faker
  const analysis = { catalogOnly: false, consts: [], params: new Map(), shapes: [{ targets: ['other' as const], json: false }] }

  it('drops browse mode’s hidden keys from the metadata, the rows and ORDER, and fakes the rest by its field', () => {
    const email = entry('email', nvarchar)
    const id = entry('id', int)
    const tabname = Buffer.concat([Buffer.from([TOKEN.TABNAME]), Buffer.from([13, 0, 1, 5, 0]), Buffer.from('users', 'utf16le')])
    const colinfo = Buffer.from([TOKEN.COLINFO, 6, 0, 1, 1, 0, 2, 1, COLINFO.HIDDEN | COLINFO.KEY])
    const payload = Buffer.concat([
      colMetadata([email, id]),
      order([2]),
      tabname,
      colinfo,
      row([email, id], [{ bytes: Buffer.from('kim@x.net', 'utf16le') }, { bytes: Buffer.from([7, 0, 0, 0]) }]),
      done(DONE.COUNT, 1),
    ])
    const rewritten = rewriteReply(payload, { analyses: [analysis], sent: [undefined], handles: [new Set()] }, { catalog, faker, maxRows: 100, database: 'app' })
    const tokens = [...readTokens(rewritten.payload)]
    expect(tokens.map((t) => t.kind)).toEqual(['colmetadata', 'row', 'done'])
    expect(tokens[0]!.kind === 'colmetadata' && tokens[0]!.columns!.map((c) => c.name)).toEqual(['email'])
    expect(tokens[1]!.kind === 'row' && tokens[1]!.values[0]!.bytes!.toString('utf16le')).toBe('fake kim@x.net')
  })
})
