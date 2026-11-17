import { hostname } from 'node:os'
import { u8, u32 } from './tds.js'

/** PRELOGIN's options (MS-TDS 2.2.6.5). */
export const OPTION = { VERSION: 0, ENCRYPTION: 1, INSTANCE: 2, THREADID: 3, MARS: 4, TRACEID: 5, FEDAUTH: 6, NONCE: 7, END: 0xff } as const

/** What each side says of encryption in PRELOGIN. */
export const ENCRYPT = { OFF: 0, ON: 1, NOT_SUP: 2, REQ: 3 } as const

export type Prelogin = Partial<Record<number, Buffer>>

export function readPrelogin(payload: Buffer): Prelogin {
  const options: Prelogin = {}
  for (let at = 0; at + 5 <= payload.length && payload[at] !== OPTION.END; at += 5) {
    const offset = payload.readUInt16BE(at + 1)
    const length = payload.readUInt16BE(at + 3)
    if (offset + length <= payload.length) options[payload[at]!] = payload.subarray(offset, offset + length)
  }
  return options
}

export function prelogin(options: [number, Buffer][]): Buffer {
  const head = Buffer.alloc(options.length * 5 + 1)
  let at = head.length
  options.forEach(([token, data], i) => {
    head[i * 5] = token
    head.writeUInt16BE(at, i * 5 + 1)
    head.writeUInt16BE(data.length, i * 5 + 3)
    at += data.length
  })
  head[head.length - 1] = OPTION.END
  return Buffer.concat([head, ...options.map(([, data]) => data)])
}

/** A version as PRELOGIN gives it: major, minor, build (big-endian), sub-build. */
export function versionBytes(version: string): Buffer {
  const [major = 16, minor = 0, build = 0] = version.split('.').map(Number)
  const out = Buffer.alloc(6)
  out[0] = major
  out[1] = minor
  out.writeUInt16BE(build & 0xffff, 2)
  return out
}

/** TDS versions as LOGIN7 and LOGINACK write them. */
export const TDS = { V7_2: 0x72090002, V7_3A: 0x730a0003, V7_3B: 0x730b0003, V7_4: 0x74000004, V8_0: 0x08000000 } as const

/** A version's rank, as 8.0 writes itself as a smaller number than 7.4. */
export function tdsRank(version: number): number {
  return version === TDS.V8_0 ? 0x80000000 : version
}

/** LOGIN7's feature extensions (MS-TDS 2.2.6.4). */
export const FEATURE = { SESSION_RECOVERY: 0x01, FEDAUTH: 0x02, COLUMN_ENCRYPTION: 0x04, GLOBAL_TRANSACTIONS: 0x05, AZURE_SQL: 0x08, DATA_CLASSIFICATION: 0x09, UTF8: 0x0a, DNS_CACHING: 0x0b, END: 0xff } as const

/** OptionFlags2's integrated security: an SSPI login, Windows' or Kerberos'. */
export const INTEGRATED_SECURITY = 0x80
/** TypeFlags' read-only intent, for an availability group's readable secondary. */
export const READ_ONLY_INTENT = 0x20
/** OptionFlags3's feature extensions present. */
const EXTENSION = 0x10
const UNKNOWN_COLLATION_HANDLING = 0x08

export interface Login7 {
  tdsVersion: number
  packetSize: number
  clientVersion: number
  clientPid: number
  connectionId: number
  optionFlags1: number
  optionFlags2: number
  typeFlags: number
  optionFlags3: number
  timeZone: number
  lcid: number
  hostName: string
  userName: string
  password: string
  appName: string
  serverName: string
  library: string
  language: string
  database: string
  clientId: Buffer
  sspi: Buffer
  attachFile: string
  changePassword: string
  /** Feature extensions by id. */
  features: Map<number, Buffer>
}

/** LOGIN7's variable fields in the order their offsets come, with where each offset is. */
const FIELDS = [
  ['hostName', 36],
  ['userName', 40],
  ['password', 44],
  ['appName', 48],
  ['serverName', 52],
  ['library', 60],
  ['language', 64],
  ['database', 68],
] as const

/** A password as LOGIN7 carries it: each byte's halves swapped, then XORed with 0xA5. */
function obfuscate(b: Buffer): Buffer {
  return Buffer.from(b.map((x) => ((((x << 4) & 0xf0) | (x >> 4)) ^ 0xa5) & 0xff))
}

function deobfuscate(b: Buffer): Buffer {
  return Buffer.from(b.map((x) => {
    const y = x ^ 0xa5
    return ((y << 4) & 0xf0) | (y >> 4)
  }))
}

export function readLogin7(p: Buffer): Login7 {
  if (p.length < 94) throw new Error('A LOGIN7 shorter than its fixed part.')
  const text = (at: number, obfuscated = false) => {
    const offset = p.readUInt16LE(at)
    const chars = p.readUInt16LE(at + 2)
    const bytes = p.subarray(offset, offset + chars * 2)
    return (obfuscated ? deobfuscate(bytes) : bytes).toString('utf16le')
  }
  const optionFlags3 = p[27]!
  const features = new Map<number, Buffer>()
  if (optionFlags3 & EXTENSION) {
    const pointer = p.readUInt16LE(56)
    if (p.readUInt16LE(58) >= 4 && pointer + 4 <= p.length) {
      for (let at = p.readUInt32LE(pointer); at < p.length && p[at] !== FEATURE.END; ) {
        const id = p[at]!
        const length = p.readUInt32LE(at + 1)
        features.set(id, p.subarray(at + 5, at + 5 + length))
        at += 5 + length
      }
    }
  }
  const sspiOffset = p.readUInt16LE(78)
  // cbSSPI says 0xffff when the token is longer, and cbSSPILong how long.
  const sspiShort = p.readUInt16LE(80)
  const sspiLength = sspiShort === 0xffff ? p.readUInt32LE(90) : sspiShort
  return {
    tdsVersion: p.readUInt32LE(4),
    packetSize: p.readUInt32LE(8),
    clientVersion: p.readUInt32LE(12),
    clientPid: p.readUInt32LE(16),
    connectionId: p.readUInt32LE(20),
    optionFlags1: p[24]!,
    optionFlags2: p[25]!,
    typeFlags: p[26]!,
    optionFlags3,
    timeZone: p.readInt32LE(28),
    lcid: p.readUInt32LE(32),
    hostName: text(36),
    userName: text(40),
    password: text(44, true),
    appName: text(48),
    serverName: text(52),
    library: text(60),
    language: text(64),
    database: text(68),
    clientId: Buffer.from(p.subarray(72, 78)),
    sspi: Buffer.from(p.subarray(sspiOffset, sspiOffset + sspiLength)),
    attachFile: text(82),
    changePassword: text(86, true),
    features,
  }
}

/** A LOGIN7 a client would send: Sosie's, for its own sessions, or one made from the client's with Sosie's login in it. */
export function login7(l: Partial<Login7> & Pick<Login7, 'userName' | 'password' | 'serverName' | 'database'>): Buffer {
  const features = l.features ?? new Map<number, Buffer>()
  const fixed = Buffer.alloc(94)
  fixed.writeUInt32LE(l.tdsVersion ?? TDS.V7_4, 4)
  fixed.writeUInt32LE(l.packetSize ?? 8000, 8)
  fixed.writeUInt32LE(l.clientVersion ?? 0x01000000, 12)
  fixed.writeUInt32LE(l.clientPid ?? process.pid, 16)
  fixed.writeUInt32LE(l.connectionId ?? 0, 20)
  fixed[24] = l.optionFlags1 ?? 0xe0
  // ODBC's session defaults (ANSI_NULLS, ANSI_WARNINGS and the rest on), and a language that must be set; never SSPI.
  fixed[25] = (l.optionFlags2 ?? 0x03) & ~INTEGRATED_SECURITY
  fixed[26] = l.typeFlags ?? 0
  fixed[27] = ((l.optionFlags3 ?? 0) | UNKNOWN_COLLATION_HANDLING | (features.size ? EXTENSION : 0)) & ~0x01
  fixed.writeInt32LE(l.timeZone ?? 0, 28)
  fixed.writeUInt32LE(l.lcid ?? 0x0409, 32)

  const values: Record<(typeof FIELDS)[number][0], Buffer> = {
    hostName: Buffer.from(l.hostName ?? hostname().slice(0, 128), 'utf16le'),
    userName: Buffer.from(l.userName, 'utf16le'),
    password: obfuscate(Buffer.from(l.password, 'utf16le')),
    appName: Buffer.from(l.appName ?? 'Sosie', 'utf16le'),
    serverName: Buffer.from(l.serverName, 'utf16le'),
    library: Buffer.from(l.library ?? 'Sosie', 'utf16le'),
    language: Buffer.from(l.language ?? '', 'utf16le'),
    database: Buffer.from(l.database, 'utf16le'),
  }
  const data: Buffer[] = []
  const pointer = Buffer.alloc(4)
  let at = 94
  for (const [field, offsetAt] of FIELDS) {
    if (field === 'library' && features.size) {
      // The extension's pointer: four bytes, between ServerName's data and CltIntName's, pointing past them all.
      fixed.writeUInt16LE(at, 56)
      fixed.writeUInt16LE(4, 58)
      data.push(pointer)
      at += 4
    }
    const value = values[field]
    fixed.writeUInt16LE(at, offsetAt)
    fixed.writeUInt16LE(value.length / 2, offsetAt + 2)
    data.push(value)
    at += value.length
  }
  fixed.set(l.clientId?.subarray(0, 6) ?? Buffer.alloc(6), 72)
  for (const offsetAt of [78, 82, 86]) fixed.writeUInt16LE(at, offsetAt)
  const extension = features.size
    ? Buffer.concat([...[...features].map(([id, value]) => Buffer.concat([u8(id), u32(value.length), value])), u8(FEATURE.END)])
    : Buffer.alloc(0)
  pointer.writeUInt32LE(at)
  const payload = Buffer.concat([fixed, ...data, extension])
  payload.writeUInt32LE(payload.length, 0)
  return payload
}
