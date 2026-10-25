import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { distinctive, normalize } from './text.js'

/** Where Sosie keeps its stores: $SOSIE_HOME, or ~/.sosie. */
export function sosieHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SOSIE_HOME || join(homedir(), '.sosie')
}

/** The folder of one upstream's store: the first 12 hex digits of the SHA-256 of its label. */
export function storeDir(home: string, label: string): string {
  return join(home, createHash('sha256').update(label).digest('hex').slice(0, 12))
}

/** Every store under a home, for `sosie scan`. */
export function storeDirs(home: string): string[] {
  if (!existsSync(home)) return []
  return readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(home, d.name, 'store.db')))
    .map((d) => join(home, d.name))
}

export interface Allocation {
  /** A fake must not repeat within its domain: keys and text, so a fake names one real value. */
  unique: boolean
  /** Whether `sosie scan` looks for the real value: not for dates, booleans and other values too common to tell apart. */
  scannable: boolean
}

/** Draws a candidate fake from a seed; `attempt` grows while candidates are taken. */
export type Draw = (seed: Uint8Array, attempt: number) => string

const ATTEMPTS_UNIQUE = 64
const ATTEMPTS = 96
const CACHE_SIZE = 50_000

/**
 * The mapping store: one SQLite file per upstream. It remembers each fake for
 * each real value, so fakes are consistent across sessions and a fake in a
 * query can be turned back into the real value. Real values are sealed with a
 * key that never leaves this folder.
 */
export class Store {
  readonly #db: DatabaseSync
  readonly #macKey: Buffer
  readonly #sealKey: Buffer
  readonly #seedKey: Buffer
  readonly #cache = new Map<string, string>()
  readonly #get: StatementSync
  readonly #taken: StatementSync
  readonly #insert: StatementSync
  readonly #byFake: StatementSync
  readonly #byFakeIn: StatementSync

  private constructor(readonly dir: string, db: DatabaseSync, key: Buffer) {
    this.#db = db
    const derive = (info: string) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32))
    this.#macKey = derive('sosie mac')
    this.#sealKey = derive('sosie seal')
    this.#seedKey = derive('sosie seed')
    this.#get = db.prepare('SELECT fake FROM value WHERE domain = ? AND mac = ?')
    this.#taken = db.prepare('SELECT 1 FROM value WHERE domain = ? AND fake = ? LIMIT 1')
    this.#insert = db.prepare(
      'INSERT OR IGNORE INTO value (domain, mac, mac_ci, fake, fake_ci, sealed, scannable) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.#byFake = db.prepare('SELECT sealed FROM value WHERE fake = ?')
    this.#byFakeIn = db.prepare('SELECT sealed FROM value WHERE fake = ? AND domain = ?')
  }

  /** Open a store, creating its folder, key and tables on first use. */
  static open(dir: string, { create = true } = {}): Store {
    const keyFile = join(dir, 'key')
    if (!existsSync(keyFile)) {
      if (!create) throw new Error(`No store in ${dir}`)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
    }
    chmodSync(keyFile, 0o600)
    const db = new DatabaseSync(join(dir, 'store.db'))
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS value (
        domain    TEXT    NOT NULL,
        mac       BLOB    NOT NULL,
        mac_ci    BLOB    NOT NULL,
        fake      TEXT    NOT NULL,
        fake_ci   TEXT    NOT NULL,
        sealed    BLOB    NOT NULL,
        scannable INTEGER NOT NULL,
        PRIMARY KEY (domain, mac)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS value_fake ON value (fake, domain);
      CREATE INDEX IF NOT EXISTS value_scan ON value (mac_ci) WHERE scannable = 1;
    `)
    return new Store(dir, db, readFileSync(keyFile))
  }

  /** A seed only this store's key can produce, for fakes that are derived and not stored. */
  seed(domain: string, real: string, attempt = 0): Uint8Array {
    return createHmac('sha256', this.#seedKey).update(`${domain}\0${real}\0${attempt}`).digest()
  }

  /** The fake of a real value in a domain: the stored one, or a new one drawn and stored. */
  fake(domain: string, real: string, allocation: Allocation, draw: Draw): string {
    const cacheKey = `${domain}\0${real}`
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined) return cached

    const mac = this.#mac(real)
    let fake = (this.#get.get(domain, mac) as { fake: string } | undefined)?.fake
    if (fake === undefined) {
      // A value with no letter or digit in it (empty, '-', NaN, infinity) has nothing to fake:
      // every draw returns it, so after the last attempt it stays as it is.
      let candidate = real
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const drawn = draw(this.seed(domain, real, attempt), attempt)
        if (drawn === real) continue
        candidate = drawn
        if (!allocation.unique || attempt >= ATTEMPTS_UNIQUE || !this.#taken.get(domain, candidate)) break
      }
      const scannable = allocation.scannable && distinctive(real) ? 1 : 0
      this.#insert.run(domain, mac, this.#macCi(real), candidate, normalize(candidate), this.#seal(real), scannable)
      // Another Sosie on the same upstream may have stored this value first; its fake wins.
      fake = (this.#get.get(domain, mac) as { fake: string }).fake
    }
    if (this.#cache.size >= CACHE_SIZE) this.#cache.clear()
    this.#cache.set(cacheKey, fake)
    return fake
  }

  /** The distinct real values a fake stands for, in one domain or in all. */
  reals(fake: string, domain?: string): string[] {
    const rows = (domain === undefined ? this.#byFake.all(fake) : this.#byFakeIn.all(fake, domain)) as {
      sealed: Uint8Array
    }[]
    return [...new Set(rows.map((r) => this.#unseal(r.sealed)))]
  }

  /** What `sosie scan` compares against: keyed hashes of distinctive real values, and every fake. */
  scanIndex(): ScanIndex {
    const reals = new Map<string, string>()
    for (const row of this.#db.prepare('SELECT mac_ci, domain FROM value WHERE scannable = 1').iterate()) {
      const { mac_ci, domain } = row as { mac_ci: Uint8Array; domain: string }
      reals.set(Buffer.from(mac_ci).toString('base64'), domain)
    }
    const fakes = new Set<string>()
    for (const row of this.#db.prepare('SELECT fake_ci FROM value').iterate()) fakes.add((row as { fake_ci: string }).fake_ci)
    const macKey = this.#macKey
    return {
      size: reals.size,
      find(normalized: string) {
        if (fakes.has(normalized)) return undefined
        return reals.get(createHmac('sha256', macKey).update(`ci\0${normalized}`).digest('base64'))
      },
    }
  }

  close(): void {
    this.#db.close()
  }

  #mac(real: string): Buffer {
    return createHmac('sha256', this.#macKey).update(real).digest()
  }

  #macCi(real: string): Buffer {
    return createHmac('sha256', this.#macKey).update(`ci\0${normalize(real)}`).digest()
  }

  #seal(real: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#sealKey, iv)
    const body = Buffer.concat([cipher.update(real, 'utf8'), cipher.final()])
    return Buffer.concat([iv, body, cipher.getAuthTag()])
  }

  #unseal(sealed: Uint8Array): string {
    const buf = Buffer.from(sealed)
    const decipher = createDecipheriv('aes-256-gcm', this.#sealKey, buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(buf.length - 16))
    return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString('utf8')
  }
}

export interface ScanIndex {
  /** Distinctive real values in the store. */
  size: number
  /** The domain of the real value a normalized candidate matches; undefined when none does, or when it is also a fake. */
  find(normalized: string): string | undefined
}
