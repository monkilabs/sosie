import { bvarchar, Cursor, u16, u8, usvarchar } from './tds.js'
import { encodeText, readTypeInfo, readValue, TYPE, writeValue, type RawValue, type TypeInfo } from './types.js'

/** The procedures an RPC names by number (MS-TDS 2.2.6.6). */
export const PROC = {
  CURSOR: 1,
  CURSOROPEN: 2,
  CURSORPREPARE: 3,
  CURSOREXECUTE: 4,
  CURSORPREPEXEC: 5,
  CURSORUNPREPARE: 6,
  CURSORFETCH: 7,
  CURSOROPTION: 8,
  CURSORCLOSE: 9,
  EXECUTESQL: 10,
  PREPARE: 11,
  EXECUTE: 12,
  PREPEXEC: 13,
  PREPEXECRPC: 14,
  UNPREPARE: 15,
} as const

const BY_NAME: Record<string, number> = {
  sp_cursor: PROC.CURSOR,
  sp_cursoropen: PROC.CURSOROPEN,
  sp_cursorprepare: PROC.CURSORPREPARE,
  sp_cursorexecute: PROC.CURSOREXECUTE,
  sp_cursorprepexec: PROC.CURSORPREPEXEC,
  sp_cursorunprepare: PROC.CURSORUNPREPARE,
  sp_cursorfetch: PROC.CURSORFETCH,
  sp_cursoroption: PROC.CURSOROPTION,
  sp_cursorclose: PROC.CURSORCLOSE,
  sp_executesql: PROC.EXECUTESQL,
  sp_prepare: PROC.PREPARE,
  sp_execute: PROC.EXECUTE,
  sp_prepexec: PROC.PREPEXEC,
  sp_prepexecrpc: PROC.PREPEXECRPC,
  sp_unprepare: PROC.UNPREPARE,
}

/** A parameter's status: passed by reference (OUTPUT), its default, or encrypted (Always Encrypted). */
export const PARAM = { BY_REF: 0x01, DEFAULT: 0x02, ENCRYPTED: 0x08 } as const

export interface Param {
  name: string
  status: number
  type: TypeInfo
  value: RawValue
}

export interface Call {
  /** The procedure, by number, or by name as the client wrote it. */
  proc: number | string
  options: number
  params: Param[]
}

export interface Rpc {
  headers: Buffer
  calls: Call[]
  /** What came between two calls: BatchFlag (0x80, 0xff) or NoExecFlag (0xfe). */
  separators: number[]
}

const SEPARATORS = new Set([0x80, 0xff, 0xfe])

/** Read an RPC request: ALL_HEADERS, then one call or several. */
export function readRpc(payload: Buffer, headersLength: number): Rpc {
  const c = new Cursor(payload)
  c.at = headersLength
  const calls: Call[] = []
  const separators: number[] = []
  while (!c.done()) {
    const length = c.u16()
    const proc = length === 0xffff ? c.u16() : c.bytes(length * 2).toString('utf16le')
    const options = c.u16()
    const params: Param[] = []
    while (!c.done() && !SEPARATORS.has(c.buf[c.at]!)) {
      const name = c.bvarchar()
      const status = c.u8()
      const type = readTypeInfo(c)
      params.push({ name, status, type, value: readValue(c, type) })
    }
    calls.push({ proc, options, params })
    if (!c.done()) separators.push(c.u8())
  }
  return { headers: payload.subarray(0, headersLength), calls, separators }
}

export function writeRpc(rpc: Rpc): Buffer {
  const parts: Buffer[] = [rpc.headers]
  rpc.calls.forEach((call, i) => {
    if (i > 0) parts.push(u8(rpc.separators[i - 1] ?? 0x80))
    parts.push(typeof call.proc === 'number' ? Buffer.concat([u16(0xffff), u16(call.proc)]) : usvarchar(call.proc), u16(call.options))
    for (const p of call.params) parts.push(bvarchar(p.name), u8(p.status), p.type.raw, writeValue(p.type, p.value))
  })
  if (rpc.separators.length >= rpc.calls.length) parts.push(u8(rpc.separators.at(-1)!))
  return Buffer.concat(parts)
}

/** The procedure a call names, as a number where it is one of the special procedures: sys.sp_executesql is 10. */
export function procOf(call: Call): number | string {
  if (typeof call.proc === 'number') return call.proc
  const name = call.proc.replace(/[[\]]/g, '').split('.').at(-1)!.toLowerCase()
  return BY_NAME[name] ?? name
}

/** A parameter's text value: the statement, a declaration. */
export function textParam(p: Param | undefined): string | undefined {
  if (!p || p.value.bytes === null) return undefined
  if (p.type.id === TYPE.NVARCHAR || p.type.id === TYPE.NCHAR || p.type.id === TYPE.NTEXT) return p.value.bytes.toString('utf16le')
  return undefined
}

/** A parameter holding text, as nvarchar(max): a statement or declaration Sosie rewrote, whatever length it now has. */
export function withText(p: Param, text: string): Param {
  const collation = p.type.collation ?? Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34])
  return { ...p, type: maxOf({ ...p.type, id: TYPE.NVARCHAR, collation }), value: { bytes: Buffer.from(text, 'utf16le') } }
}

/** A text or binary type at its max: nvarchar(max), varchar(max), varbinary(max). */
export function maxOf(t: TypeInfo): TypeInfo {
  const id =
    t.id === TYPE.NCHAR || t.id === TYPE.NVARCHAR || t.id === TYPE.NTEXT
      ? TYPE.NVARCHAR
      : t.id === TYPE.BIGCHAR || t.id === TYPE.BIGVARCHAR || t.id === TYPE.TEXT
        ? TYPE.BIGVARCHAR
        : TYPE.BIGVARBINARY
  const collation = id === TYPE.BIGVARBINARY ? undefined : (t.collation ?? Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34]))
  return { id, layout: 'plp', length: 0xffff, ...(collation && { collation }), raw: Buffer.concat([u8(id), u16(0xffff), ...(collation ? [collation] : [])]) }
}

/** Whether a value's bytes fit its parameter's type, or need it at its max. */
export function fits(t: TypeInfo, text: string): boolean {
  if (t.layout !== 'ushort') return true
  if (t.id === TYPE.NVARCHAR || t.id === TYPE.NCHAR) return Buffer.byteLength(text, 'utf16le') <= t.length
  if (t.id === TYPE.BIGVARCHAR || t.id === TYPE.BIGCHAR) return encodeText(text, t.collation).length <= t.length
  return true
}

/** One parameter of a declaration: @p1 nvarchar(4000) OUTPUT. */
export interface Declared {
  /** Lowercased, @ and all. */
  name: string
  output: boolean
  /** Where its type is in the declaration's text. */
  typeStart: number
  typeEnd: number
  type: string
}

/** A declaration's parameters, split at its top-level commas. */
export function readDeclarations(text: string): Declared[] {
  const out: Declared[] = []
  let depth = 0
  let from = 0
  const add = (end: number) => {
    const piece = text.slice(from, end)
    const m = /^(\s*)(@[\w@#$]+)(\s+)(.*?)(\s+(output|out))?\s*$/is.exec(piece)
    if (m) {
      const typeStart = from + m[1]!.length + m[2]!.length + m[3]!.length
      out.push({ name: m[2]!.toLowerCase(), output: !!m[5], typeStart, typeEnd: typeStart + m[4]!.length, type: m[4]! })
    }
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      add(i)
      from = i + 1
    }
  }
  if (text.trim()) add(text.length)
  return out
}

/** A declaration with these parameters' types at their max: varchar(5) becomes varchar(max), so a real value is not cut. */
export function widen(text: string, declared: readonly Declared[], names: ReadonlySet<string>): string {
  let out = text
  for (const d of [...declared].sort((a, b) => b.typeStart - a.typeStart)) {
    if (!names.has(d.name)) continue
    const base = d.type.trim().toLowerCase().replace(/\s*\(.*$/, '')
    const max = base === 'nchar' || base === 'nvarchar' || base === 'ntext' ? 'nvarchar(max)' : base === 'char' || base === 'varchar' || base === 'text' ? 'varchar(max)' : base === 'binary' || base === 'varbinary' ? 'varbinary(max)' : undefined
    if (max) out = out.slice(0, d.typeStart) + max + out.slice(d.typeEnd)
  }
  return out
}
