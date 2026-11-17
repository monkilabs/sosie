import { bvarchar, Cursor, i32, u16, u32, u64, u8, usvarchar } from './tds.js'
import { readTypeInfo, readValue, writeValue, type RawValue, type TypeInfo } from './types.js'

/** The tokens of a reply (MS-TDS 2.2.7). */
export const TOKEN = {
  COLMETADATA: 0x81,
  TABNAME: 0xa4,
  COLINFO: 0xa5,
  ORDER: 0xa9,
  ERROR: 0xaa,
  INFO: 0xab,
  RETURNVALUE: 0xac,
  LOGINACK: 0xad,
  FEATUREEXTACK: 0xae,
  ROW: 0xd1,
  NBCROW: 0xd2,
  ENVCHANGE: 0xe3,
  SESSIONSTATE: 0xe4,
  SSPI: 0xed,
  FEDAUTHINFO: 0xee,
  RETURNSTATUS: 0x79,
  DONE: 0xfd,
  DONEPROC: 0xfe,
  DONEINPROC: 0xff,
} as const

/** DONE's status bits. */
export const DONE = { FINAL: 0x00, MORE: 0x01, ERROR: 0x02, INXACT: 0x04, COUNT: 0x10, ATTN: 0x20, SRVERROR: 0x100 } as const

/** ENVCHANGE's types. */
export const ENV = {
  DATABASE: 1,
  LANGUAGE: 2,
  CHARSET: 3,
  PACKET_SIZE: 4,
  SORT_LOCALE: 5,
  SORT_FLAGS: 6,
  COLLATION: 7,
  BEGIN_TRAN: 8,
  COMMIT_TRAN: 9,
  ROLLBACK_TRAN: 10,
  ENLIST_DTC: 11,
  DEFECT_TRAN: 12,
  MIRROR_PARTNER: 13,
  PROMOTE_TRAN: 15,
  TRAN_MANAGER: 16,
  TRAN_ENDED: 17,
  RESET_ACK: 18,
  USER_INSTANCE: 19,
  ROUTING: 20,
} as const

/** COLINFO's status bits: a column that is an expression, part of a key, hidden (browse mode added it), or renamed. */
export const COLINFO = { EXPRESSION: 0x04, KEY: 0x08, HIDDEN: 0x10, DIFFERENT_NAME: 0x20 } as const

export interface Column {
  userType: number
  flags: number
  type: TypeInfo
  name: string
  /** The column's whole entry of COLMETADATA, written back as it came. */
  raw: Buffer
}

export interface ColumnInfo {
  /** The column's ordinal, from 1. */
  column: number
  /** Which table of TABNAME, from 1; 0 for none. */
  table: number
  status: number
  /** The table's own name for the column, where the result renamed it. */
  name?: string
}

export interface Message {
  error: boolean
  number: number
  state: number
  severity: number
  text: string
  server: string
  proc: string
  line: number
}

export type Token =
  | { kind: 'colmetadata'; columns: Column[] | null; raw: Buffer }
  | { kind: 'tabname'; tables: string[][]; raw: Buffer }
  | { kind: 'colinfo'; infos: ColumnInfo[]; raw: Buffer }
  | { kind: 'order'; columns: number[]; raw: Buffer }
  | { kind: 'row'; values: RawValue[]; raw: Buffer }
  | { kind: 'done'; token: number; status: number; curcmd: number; rows: bigint; raw: Buffer }
  | ({ kind: 'message'; raw: Buffer } & Message)
  | { kind: 'envchange'; type: number; data: Buffer; raw: Buffer }
  | { kind: 'loginack'; tds: number; program: string; version: Buffer; raw: Buffer }
  | { kind: 'featureextack'; features: Map<number, Buffer>; raw: Buffer }
  | { kind: 'returnstatus'; value: number; raw: Buffer }
  | { kind: 'returnvalue'; ordinal: number; name: string; status: number; userType: number; flags: number; type: TypeInfo; value: RawValue; raw: Buffer }
  | { kind: 'other'; token: number; raw: Buffer }

export class UnreadTokenError extends Error {
  constructor(token: number) {
    super(`A reply token 0x${token.toString(16)} Sosie does not read.`)
  }
}

/**
 * The tokens of a reply, in order. A row is read with the columns of the COLMETADATA before it; `columns` is where
 * that starts, for a reply whose metadata came in an earlier one.
 */
export function* readTokens(buf: Buffer, columns: Column[] = []): Generator<Token> {
  const c = new Cursor(buf)
  let current = columns
  while (!c.done()) {
    const start = c.at
    const token = c.u8()
    const raw = () => buf.subarray(start, c.at)
    switch (token) {
      case TOKEN.COLMETADATA: {
        const count = c.u16()
        if (count === 0xffff) {
          yield { kind: 'colmetadata', columns: null, raw: raw() }
          break
        }
        const read: Column[] = []
        for (let i = 0; i < count; i++) {
          const at = c.at
          const userType = c.u32()
          const flags = c.u16()
          const type = readTypeInfo(c)
          if (type.layout === 'text') for (let parts = c.u8(); parts > 0; parts--) c.usvarchar()
          const name = c.bvarchar()
          read.push({ userType, flags, type, name, raw: Buffer.from(buf.subarray(at, c.at)) })
        }
        current = read
        yield { kind: 'colmetadata', columns: read, raw: raw() }
        break
      }
      case TOKEN.TABNAME: {
        const end = c.u16() + c.at
        const tables: string[][] = []
        while (c.at < end) {
          const parts: string[] = []
          for (let n = c.u8(); n > 0; n--) parts.push(c.usvarchar())
          tables.push(parts)
        }
        yield { kind: 'tabname', tables, raw: raw() }
        break
      }
      case TOKEN.COLINFO: {
        const end = c.u16() + c.at
        const infos: ColumnInfo[] = []
        while (c.at < end) {
          const column = c.u8()
          const table = c.u8()
          const status = c.u8()
          infos.push({ column, table, status, ...(status & COLINFO.DIFFERENT_NAME && { name: c.bvarchar() }) })
        }
        yield { kind: 'colinfo', infos, raw: raw() }
        break
      }
      case TOKEN.ORDER: {
        const end = c.u16() + c.at
        const ordered: number[] = []
        while (c.at < end) ordered.push(c.u16())
        yield { kind: 'order', columns: ordered, raw: raw() }
        break
      }
      case TOKEN.ROW:
        yield { kind: 'row', values: current.map((col) => readValue(c, col.type)), raw: raw() }
        break
      case TOKEN.NBCROW: {
        const bitmap = c.bytes(Math.ceil(current.length / 8))
        const values = current.map((col, i) => (bitmap[i >> 3]! & (1 << (i & 7)) ? { bytes: null } : readValue(c, col.type)))
        yield { kind: 'row', values, raw: raw() }
        break
      }
      case TOKEN.DONE:
      case TOKEN.DONEPROC:
      case TOKEN.DONEINPROC: {
        const status = c.u16()
        const curcmd = c.u16()
        const rows = c.u64()
        yield { kind: 'done', token, status, curcmd, rows, raw: raw() }
        break
      }
      case TOKEN.ERROR:
      case TOKEN.INFO: {
        const end = c.u16() + c.at
        const number = c.i32()
        const state = c.u8()
        const severity = c.u8()
        const text = c.usvarchar()
        const server = c.bvarchar()
        const proc = c.bvarchar()
        const line = c.left >= 4 && c.at + 4 <= end ? c.i32() : 0
        c.at = end
        yield { kind: 'message', error: token === TOKEN.ERROR, number, state, severity, text, server, proc, line, raw: raw() }
        break
      }
      case TOKEN.ENVCHANGE: {
        const length = c.u16()
        const data = c.bytes(length)
        yield { kind: 'envchange', type: data[0] ?? 0, data, raw: raw() }
        break
      }
      case TOKEN.LOGINACK: {
        const end = c.u16() + c.at
        c.u8()
        const tds = c.u32()
        const program = c.bvarchar()
        const version = c.bytes(4)
        c.at = end
        yield { kind: 'loginack', tds, program, version, raw: raw() }
        break
      }
      case TOKEN.FEATUREEXTACK: {
        const features = new Map<number, Buffer>()
        for (let id = c.u8(); id !== 0xff; id = c.u8()) features.set(id, c.bytes(c.u32()))
        yield { kind: 'featureextack', features, raw: raw() }
        break
      }
      case TOKEN.RETURNSTATUS:
        yield { kind: 'returnstatus', value: c.i32(), raw: raw() }
        break
      case TOKEN.RETURNVALUE: {
        const ordinal = c.u16()
        const name = c.bvarchar()
        const status = c.u8()
        const userType = c.u32()
        const flags = c.u16()
        const type = readTypeInfo(c)
        const value = readValue(c, type)
        yield { kind: 'returnvalue', ordinal, name, status, userType, flags, type, value, raw: raw() }
        break
      }
      case TOKEN.SSPI:
        c.bytes(c.u16())
        yield { kind: 'other', token, raw: raw() }
        break
      case TOKEN.SESSIONSTATE:
      case TOKEN.FEDAUTHINFO:
        c.bytes(c.u32())
        yield { kind: 'other', token, raw: raw() }
        break
      default:
        throw new UnreadTokenError(token)
    }
  }
}

/* Writing tokens. */

export function colMetadata(columns: Column[]): Buffer {
  return Buffer.concat([u8(TOKEN.COLMETADATA), u16(columns.length), ...columns.map((c) => c.raw)])
}

/** A row of values of these columns, as ROW: every layout but a fixed one can say null. */
export function row(columns: Column[], values: RawValue[]): Buffer {
  return Buffer.concat([u8(TOKEN.ROW), ...columns.map((c, i) => writeValue(c.type, values[i] ?? { bytes: null }))])
}

export function order(columns: number[]): Buffer {
  return Buffer.concat([u8(TOKEN.ORDER), u16(columns.length * 2), ...columns.map(u16)])
}

export function done(status: number, rows: bigint | number = 0, token: number = TOKEN.DONE, curcmd = 0): Buffer {
  return Buffer.concat([u8(token), u16(status), u16(curcmd), u64(rows)])
}

/** An ERROR or INFO token. */
export function message(m: Message): Buffer {
  const body = Buffer.concat([i32(m.number), u8(m.state), u8(m.severity), usvarchar(m.text), bvarchar(m.server), bvarchar(m.proc), i32(m.line)])
  return Buffer.concat([u8(m.error ? TOKEN.ERROR : TOKEN.INFO), u16(body.length), body])
}

/** An ENVCHANGE of text, as most types are: the new value, then the old. */
export function envText(type: number, now: string, before = ''): Buffer {
  const body = Buffer.concat([u8(type), bvarchar(now), bvarchar(before)])
  return Buffer.concat([u8(TOKEN.ENVCHANGE), u16(body.length), body])
}

/** An ENVCHANGE of bytes: the collation, a transaction's descriptor. */
export function envBytes(type: number, now: Buffer, before: Buffer = Buffer.alloc(0)): Buffer {
  const body = Buffer.concat([u8(type), u8(now.length), now, u8(before.length), before])
  return Buffer.concat([u8(TOKEN.ENVCHANGE), u16(body.length), body])
}

export function loginAck(tds: number, program: string, version: Buffer): Buffer {
  const tdsBytes = Buffer.alloc(4)
  tdsBytes.writeUInt32BE(tds >>> 0)
  const body = Buffer.concat([u8(1), tdsBytes, bvarchar(program), version.subarray(0, 4)])
  return Buffer.concat([u8(TOKEN.LOGINACK), u16(body.length), body])
}

export function returnValue(t: Extract<Token, { kind: 'returnvalue' }>, value: RawValue): Buffer {
  return Buffer.concat([u8(TOKEN.RETURNVALUE), u16(t.ordinal), bvarchar(t.name), u8(t.status), u32(t.userType), u16(t.flags), t.type.raw, writeValue(t.type, value)])
}

/** A column's entry of COLMETADATA as it comes, with its flags changed: the nullable bit, for a value faked as null. */
export function withFlags(column: Column, flags: number): Column {
  const raw = Buffer.from(column.raw)
  raw.writeUInt16LE(flags, 4)
  return { ...column, flags, raw }
}

/** COLMETADATA's nullable flag. */
export const NULLABLE = 0x0001

