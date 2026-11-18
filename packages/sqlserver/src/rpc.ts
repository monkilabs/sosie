import { bvarchar, Cursor, u16, u32, u8, usvarchar } from './tds.js'
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
      params.push({ name, status, type, value: readParamValue(c, type) })
    }
    calls.push({ proc, options, params })
    if (!c.done()) separators.push(c.u8())
  }
  return { headers: payload.subarray(0, headersLength), calls, separators }
}

/**
 * A parameter's value. Text, ntext and image come as a row does not send them: a four-byte length (all ones for null)
 * and their bytes, with no text pointer or timestamp before them.
 */
function readParamValue(c: Cursor, type: TypeInfo): RawValue {
  if (type.layout !== 'text') return readValue(c, type)
  const length = c.u32()
  return length === NULL_LONG ? { bytes: null } : { bytes: c.bytes(length) }
}

function writeParamValue(type: TypeInfo, value: RawValue): Buffer {
  if (type.layout !== 'text') return writeValue(type, value)
  return value.bytes === null ? u32(NULL_LONG) : Buffer.concat([u32(value.bytes.length), value.bytes])
}

const NULL_LONG = 0xffffffff

export function writeRpc(rpc: Rpc): Buffer {
  const parts: Buffer[] = [rpc.headers]
  rpc.calls.forEach((call, i) => {
    if (i > 0) parts.push(u8(rpc.separators[i - 1] ?? 0x80))
    parts.push(typeof call.proc === 'number' ? Buffer.concat([u16(0xffff), u16(call.proc)]) : usvarchar(call.proc), u16(call.options))
    for (const p of call.params) parts.push(bvarchar(p.name), u8(p.status), p.type.raw, writeParamValue(p.type, p.value))
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
function fits(t: TypeInfo, text: string): boolean {
  if (t.layout !== 'ushort') return true
  if (t.id === TYPE.NVARCHAR || t.id === TYPE.NCHAR) return Buffer.byteLength(text, 'utf16le') <= t.length
  if (t.id === TYPE.BIGVARCHAR || t.id === TYPE.BIGCHAR) return encodeText(text, t.collation).length <= t.length
  return true
}

/**
 * A type that holds a real value its parameter's would cut, the parameter having been sized to the fake (SqlClient
 * sizes a string or a decimal to its value: 12.5 is decimal(3,1)); undefined where it fits. Text and bytes go at
 * their max, a decimal at precision 38 with the scale it needs, an integer as a bigint.
 */
export function widerFor(t: TypeInfo, real: string): TypeInfo | undefined {
  if (t.id === TYPE.DECIMALN || t.id === TYPE.NUMERICN) {
    const m = /^[+-]?0*(\d*)(?:\.(\d*?)0*)?$/.exec(real.trim())
    if (!m) return undefined
    const whole = m[1]!.length
    const fraction = (m[2] ?? '').length
    const scale = t.scale ?? 0
    if (whole <= (t.precision ?? 18) - scale && fraction <= scale) return undefined
    if (whole > 38) return undefined
    const wider = Math.min(Math.max(scale, fraction), 38 - whole)
    return { id: t.id, layout: 'bytelen', length: 17, precision: 38, scale: wider, raw: Buffer.from([t.id, 17, 38, wider]) }
  }
  if (t.id === TYPE.INTN && t.length < 8) {
    if (!/^-?\d+$/.test(real)) return undefined
    const n = BigInt(real)
    const max = t.length === 1 ? 255n : (1n << BigInt(t.length * 8 - 1)) - 1n
    const min = t.length === 1 ? 0n : -max - 1n
    return n >= min && n <= max ? undefined : { id: TYPE.INTN, layout: 'bytelen', length: 8, raw: Buffer.from([TYPE.INTN, 8]) }
  }
  return fits(t, real) ? undefined : maxOf(t)
}

/** A type as a declaration writes it: the wider types widerFor gives. */
function declared(t: TypeInfo): string | undefined {
  if (t.id === TYPE.NVARCHAR && t.layout === 'plp') return 'nvarchar(max)'
  if (t.id === TYPE.BIGVARCHAR && t.layout === 'plp') return 'varchar(max)'
  if (t.id === TYPE.BIGVARBINARY && t.layout === 'plp') return 'varbinary(max)'
  if (t.id === TYPE.DECIMALN) return `decimal(${t.precision},${t.scale})`
  if (t.id === TYPE.NUMERICN) return `numeric(${t.precision},${t.scale})`
  if (t.id === TYPE.INTN && t.length === 8) return 'bigint'
  return undefined
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

/**
 * A declaration with these parameters in their wider types, as widerFor gave them: varchar(5) becomes varchar(max),
 * decimal(3,1) decimal(38,2), so a real value is not cut.
 */
export function widen(text: string, parameters: readonly Declared[], wider: ReadonlyMap<string, TypeInfo>): string {
  let out = text
  for (const d of [...parameters].sort((a, b) => b.typeStart - a.typeStart)) {
    const type = wider.get(d.name)
    const written = type && declared(type)
    if (written) out = out.slice(0, d.typeStart) + written + out.slice(d.typeEnd)
  }
  return out
}
