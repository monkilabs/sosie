import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { endpointCertificate } from '../src/certificate.js'
import { FEATURE, login7, readLogin7, TDS } from '../src/login.js'
import { procOf, PROC, readDeclarations, readRpc, widen, widerFor, writeRpc } from '../src/rpc.js'
import { allHeaders, Cursor, Messages, packets, PACKET } from '../src/tds.js'
import { readTokens, row, colMetadata, done, message, order, DONE, TOKEN, COLINFO } from '../src/tokens.js'
import { rewriteReply } from '../src/results.js'
import { buildCatalog } from '../src/schema.js'
import type { Faker } from '@sosie/core'
import { bytesOf, readTypeInfo, textOf, TYPE } from '../src/types.js'
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
    const five = readTypeInfo(new Cursor(Buffer.from([TYPE.NVARCHAR, 10, 0, 0x09, 0x04, 0xd0, 0x00, 0x34])))
    expect(widerFor(five, 'abcde')).toBeUndefined()
    const wider = widerFor(five, 'abcdef')!
    expect(wider.layout).toBe('plp')
    expect(widen('@p0 nvarchar(5),@p1 decimal(10, 2)', declared, new Map([['@p0', wider]]))).toBe('@p0 nvarchar(max),@p1 decimal(10, 2)')
  })

  it('names a special or catalog procedure only in sys or dbo: in a schema of yours, it is a procedure of yours', () => {
    const named = (proc: string) => procOf({ proc, options: 0, params: [] })
    expect(named('sp_tables')).toBe('sp_tables')
    expect(named('dbo.sp_tables')).toBe('sp_tables')
    expect(named('[sys].[sp_executesql]')).toBe(PROC.EXECUTESQL)
    expect(named('otherdb..sp_columns')).toBe('sp_columns')
    expect(named('app.sp_tables')).toBe('app.sp_tables')
    expect(named('[app].[sp_executesql]')).toBe('app.sp_executesql')
    expect(named('otherdb.app.sp_tables')).toBe('otherdb.app.sp_tables')
    // A linked server's.
    expect(named('remote.master.dbo.sp_tables')).toBe('remote.master.dbo.sp_tables')
  })

  it('widens a number whose real value its parameter, sized to the fake, would cut', () => {
    // SqlClient sizes a decimal to its value: 12.5 is decimal(3,1), which would cut 1234.56 to 99.9.
    const small = readTypeInfo(new Cursor(Buffer.from([TYPE.DECIMALN, 5, 3, 1])))
    expect(widerFor(small, '12.5')).toBeUndefined()
    const decimal = widerFor(small, '1234.56')!
    expect([decimal.precision, decimal.scale]).toEqual([38, 2])
    expect(textOf(decimal, bytesOf(decimal, '1234.56')!)).toBe('1234.56')
    expect(widen('@p0 decimal(3,1)', readDeclarations('@p0 decimal(3,1)'), new Map([['@p0', decimal]]))).toBe('@p0 decimal(38,2)')
    // An int compared with a bigint column: a real value past an int's range goes as a bigint.
    const int = readTypeInfo(new Cursor(Buffer.from([TYPE.INTN, 4])))
    expect(widerFor(int, '2147483647')).toBeUndefined()
    const big = widerFor(int, '9000000000')!
    expect(textOf(big, bytesOf(big, '9000000000')!)).toBe('9000000000')
    expect(widen('@p0 int', readDeclarations('@p0 int'), new Map([['@p0', big]]))).toBe('@p0 bigint')
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

  it('says a result is ordered by no more than the columns before the first hidden key in ORDER', () => {
    // ORDER BY u.id, u.email: by email only within each id, which the client does not see.
    const email = entry('email', nvarchar)
    const id = entry('id', int)
    const tabname = Buffer.concat([Buffer.from([TOKEN.TABNAME]), Buffer.from([13, 0, 1, 5, 0]), Buffer.from('users', 'utf16le')])
    const colinfo = Buffer.from([TOKEN.COLINFO, 6, 0, 1, 1, 0, 2, 1, COLINFO.HIDDEN | COLINFO.KEY])
    const reply = (ordered: number[]) => Buffer.concat([colMetadata([email, id]), order(ordered), tabname, colinfo, row([email, id], [{ bytes: Buffer.from('kim@x.net', 'utf16le') }, { bytes: Buffer.from([7, 0, 0, 0]) }]), done(DONE.COUNT, 1)])
    const orders = (ordered: number[]) => [...readTokens(rewriteReply(reply(ordered), { analyses: [analysis], sent: [undefined], handles: [new Set()] }, { catalog, faker, maxRows: 100, database: 'app' }).payload)].flatMap((t) => (t.kind === 'order' ? [t.columns] : []))
    expect(orders([2, 1])).toEqual([])
    expect(orders([1, 2])).toEqual([[1]])
  })

  it('fakes a column whose table it cannot find, in whichever database the session is', () => {
    // From master, a view of app names its table as the view's text wrote it: dbo.users, which is not master's.
    const email = entry('email', nvarchar)
    const name = (parts: string[]) => Buffer.concat([Buffer.from([parts.length]), ...parts.map((p) => Buffer.concat([Buffer.from([p.length, 0]), Buffer.from(p, 'utf16le')]))])
    const tables = name(['dbo', 'users'])
    const payload = Buffer.concat([
      colMetadata([email]),
      Buffer.from([TOKEN.TABNAME, tables.length, 0]),
      tables,
      Buffer.from([TOKEN.COLINFO, 3, 0, 1, 1, 0]),
      row([email], [{ bytes: Buffer.from('kim@x.net', 'utf16le') }]),
      done(DONE.COUNT, 1),
    ])
    const rewritten = rewriteReply(payload, { analyses: [analysis], sent: [undefined], handles: [new Set()] }, { catalog, faker, maxRows: 100, database: 'master' })
    const value = [...readTokens(rewritten.payload)].find((t) => t.kind === 'row')
    expect(value?.kind === 'row' && value.values[0]!.bytes!.toString('utf16le')).not.toBe('kim@x.net')
  })

  it('reads no result set as the guard said once a statement failed: the sets after it may not be the ones it counted', () => {
    // SELECT 1 AS n FROM denied; SELECT salary + 0 AS n FROM emp: the first fails, and the second's set comes first.
    const n = entry('n', int)
    const counted = { catalogOnly: false, consts: [], params: new Map(), shapes: [{ targets: ['constant' as const], json: false }, { targets: ['other' as const], json: false }] }
    const payload = Buffer.concat([
      message({ error: true, number: 229, state: 5, severity: 14, text: "The SELECT permission was denied on the object 'denied'.", server: 'db1', proc: '', line: 1 }),
      done(DONE.ERROR | DONE.MORE),
      colMetadata([n]),
      Buffer.from([TOKEN.COLINFO, 3, 0, 1, 0, COLINFO.EXPRESSION]),
      row([n], [{ bytes: Buffer.from([0x40, 0xe2, 0x01, 0x00]) }]),
      done(DONE.COUNT, 1),
    ])
    const rewritten = rewriteReply(payload, { analyses: [counted], sent: [undefined], handles: [new Set()] }, { catalog, faker, maxRows: 100, database: 'app' })
    const value = [...readTokens(rewritten.payload)].find((t) => t.kind === 'row')
    expect(value?.kind === 'row' && value.values[0]!.bytes?.readInt32LE()).not.toBe(123456)
  })
})
