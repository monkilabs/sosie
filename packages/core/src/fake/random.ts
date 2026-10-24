/** A deterministic generator seeded from a keyed hash, so the same real value always draws the same fake. */
export class Random {
  #a: number
  #b: number
  #c: number
  #d: number

  constructor(seed: Uint8Array) {
    const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength)
    this.#a = view.getUint32(0)
    this.#b = view.getUint32(4)
    this.#c = view.getUint32(8)
    this.#d = view.getUint32(12) | 1
  }

  /** The seed faker takes. */
  words(): number[] {
    return [this.#a, this.#b, this.#c, this.#d]
  }

  /** A float in [0, 1): sfc32. */
  next(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0
    this.#d = (this.#d + 1) | 0
    this.#a = this.#b ^ (this.#b >>> 9)
    this.#b = (this.#c + (this.#c << 3)) | 0
    this.#c = (this.#c << 21) | (this.#c >>> 11)
    this.#c = (this.#c + t) | 0
    return (t >>> 0) / 4294967296
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** A bigint in [min, max]. */
  bigint(min: bigint, max: bigint): bigint {
    const span = max - min + 1n
    let n = 0n
    for (let bits = 0n; 1n << bits < span * 1024n; bits += 32n) n = (n << 32n) | BigInt(this.int(0, 0xffffffff))
    return min + (n % span)
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!
  }

  /** A fixed shuffle of the items. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = LOWER.toUpperCase()

/** Letters and digits replaced, everything else kept: 'AB-1234' becomes 'QX-8071'. A leading digit stays non-zero. */
export function shape(real: string, random: Random): string {
  let out = ''
  for (let i = 0; i < real.length; i++) {
    const ch = real[i]!
    if (ch >= '0' && ch <= '9') {
      const leading = (i === 0 || !/[0-9]/.test(real[i - 1]!)) && /[0-9]/.test(real[i + 1] ?? '')
      out += String(random.int(leading ? 1 : 0, 9))
    } else if (ch >= 'a' && ch <= 'z') out += random.pick([...LOWER])
    else if (ch >= 'A' && ch <= 'Z') out += random.pick([...UPPER])
    else if (/\p{L}/u.test(ch)) out += ch === ch.toUpperCase() ? random.pick([...UPPER]) : random.pick([...LOWER])
    else out += ch
  }
  return out
}

/** The fake in the real value's case: all capitals, all lower case, or as generated. */
export function matchCase(real: string, fake: string): string {
  if (!/\p{L}/u.test(real)) return fake
  if (real === real.toUpperCase()) return fake.toUpperCase()
  if (real === real.toLowerCase()) return fake.toLowerCase()
  return fake
}
