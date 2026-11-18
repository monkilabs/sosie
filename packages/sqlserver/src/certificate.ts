import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'

/*
 * The endpoint's certificate: a CA of Sosie's own, made once in SOSIE_HOME, and a certificate it signs for the
 * names clients reach the endpoint by. A client that trusts the CA checks the endpoint as it would SQL Server, in TDS
 * 8's strict mode too; any other trusts it by TrustServerCertificate=true. Node signs, but makes no certificate:
 * this writes the few DER structures X.509 needs.
 */

const der = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), length(content.length), content])

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items))
const set = (...items: Buffer[]) => der(0x31, Buffer.concat(items))
const explicit = (n: number, content: Buffer) => der(0xa0 + n, content)
const octets = (b: Buffer) => der(0x04, b)
const bits = (b: Buffer, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), b]))
const utf8 = (text: string) => der(0x0c, Buffer.from(text, 'utf8'))
const TRUE = der(0x01, Buffer.from([0xff]))

function integer(b: Buffer): Buffer {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  const v = b.subarray(i)
  return der(0x02, v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v)
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a! + b!]
  for (const n of rest) {
    const chunk: number[] = []
    for (let v = n; ; v = Math.floor(v / 128)) {
      chunk.unshift((v % 128) | (chunk.length ? 0x80 : 0))
      if (v < 128) break
    }
    out.push(...chunk)
  }
  return der(0x06, Buffer.from(out))
}

/** UTCTime until 2049, GeneralizedTime from 2050, as RFC 5280 asks. */
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return at.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${iso.slice(2)}Z`)) : der(0x18, Buffer.from(`${iso}Z`))
}

const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
}

const name = (common: string) => sequence(set(sequence(oid(OID.organization), utf8('Sosie'))), set(sequence(oid(OID.commonName), utf8(common))))
const extension = (id: string, value: Buffer, critical = false) => sequence(oid(id), ...(critical ? [TRUE] : []), octets(value))

/** The key's identifier, as RFC 5280 suggests: the SHA-1 of its public key's bits. */
function keyId(spki: Buffer): Buffer {
  // SubjectPublicKeyInfo ends with the key's BIT STRING; for P-256 the 65 bytes of its point.
  return createHash('sha1').update(spki.subarray(spki.length - 65)).digest()
}

function altNames(hosts: readonly string[]): Buffer {
  return sequence(
    ...hosts.map((host) => {
      const kind = isIP(host)
      if (kind === 4) return der(0x87, Buffer.from(host.split('.').map(Number)))
      if (kind === 6) return der(0x87, ipv6(host))
      return der(0x82, Buffer.from(host, 'ascii'))
    }),
  )
}

function ipv6(host: string): Buffer {
  const [head, tail] = host.split('::')
  const groups = (part?: string) => (part ? part.split(':').map((g) => Number.parseInt(g, 16)) : [])
  const left = groups(head)
  const right = groups(tail)
  const all = tail === undefined ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
  const out = Buffer.alloc(16)
  all.forEach((g, i) => out.writeUInt16BE(g, i * 2))
  return out
}

interface Issued {
  key: KeyObject
  pem: string
}

function issue({ subject, issuer, publicKey, signer, ca, hosts, days, authority }: {
  subject: string
  issuer: string
  publicKey: KeyObject
  signer: KeyObject
  ca: boolean
  hosts?: readonly string[]
  days: number
  authority?: Buffer
}): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const now = Date.now()
  const extensions = [
    extension(OID.basicConstraints, ca ? sequence(TRUE, integer(Buffer.from([0]))) : sequence(), true),
    // keyCertSign and cRLSign for the CA; digitalSignature for the endpoint.
    extension(OID.keyUsage, ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7), true),
    ...(ca ? [] : [extension(OID.extKeyUsage, sequence(oid(OID.serverAuth))), extension(OID.subjectAltName, altNames(hosts ?? []))]),
    extension(OID.subjectKeyId, octets(keyId(spki))),
    ...(authority ? [extension(OID.authorityKeyId, sequence(der(0x80, authority)))] : []),
  ]
  const algorithm = sequence(oid(OID.ecdsaSha256))
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    algorithm,
    name(issuer),
    sequence(time(new Date(now - 86_400_000)), time(new Date(now + days * 86_400_000))),
    name(subject),
    spki,
    explicit(3, sequence(...extensions)),
  )
  const signature = sign('sha256', tbs, signer)
  const cert = sequence(tbs, algorithm, bits(signature))
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}

const CA_NAME = 'Sosie local CA'

function newKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' })
}

/** A file only its owner reads, written whole or not at all. */
function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

export interface EndpointCertificate {
  /** The CA's certificate, for a client to trust: SOSIE_HOME/tls/ca.pem. */
  caPath: string
  ca: string
  key: string
  cert: string
}

/** The days an endpoint's certificate is good for: under 398, which some clients hold any certificate to. */
const ENDPOINT_DAYS = 397
const CA_DAYS = 3650

/**
 * The CA, made the first time in `home`/tls, and a certificate it signs for these hosts: made again when it lacks one,
 * or has less than a month left.
 */
export function endpointCertificate(home: string, hosts: readonly string[]): EndpointCertificate {
  const dir = join(home, 'tls')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const paths = { caKey: join(dir, 'ca.key'), ca: join(dir, 'ca.pem'), key: join(dir, 'endpoint.key'), cert: join(dir, 'endpoint.pem') }

  let ca: Issued
  if (existsSync(paths.caKey) && existsSync(paths.ca) && !expiring(readFileSync(paths.ca, 'utf8'), 30)) {
    ca = { key: createPrivateKey(readFileSync(paths.caKey, 'utf8')), pem: readFileSync(paths.ca, 'utf8') }
  } else {
    const { privateKey, publicKey } = newKey()
    const pem = issue({ subject: CA_NAME, issuer: CA_NAME, publicKey, signer: privateKey, ca: true, days: CA_DAYS })
    writePrivate(paths.caKey, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    writeFileSync(paths.ca, pem)
    ca = { key: privateKey, pem }
  }

  const caCert = new X509Certificate(ca.pem)
  if (existsSync(paths.key) && existsSync(paths.cert)) {
    const cert = readFileSync(paths.cert, 'utf8')
    const current = new X509Certificate(cert)
    if (current.verify(caCert.publicKey) && !expiring(cert, 30) && hosts.every((host) => names(current, host))) {
      return { caPath: paths.ca, ca: ca.pem, key: readFileSync(paths.key, 'utf8'), cert }
    }
  }
  const { privateKey, publicKey } = newKey()
  const authority = keyId(caCert.publicKey.export({ type: 'spki', format: 'der' }))
  const all = [...new Set(['localhost', '127.0.0.1', '::1', ...hosts])]
  const cert = issue({ subject: 'Sosie', issuer: CA_NAME, publicKey, signer: ca.key, ca: false, hosts: all, days: ENDPOINT_DAYS, authority })
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  writePrivate(paths.key, key)
  writeFileSync(paths.cert, cert)
  return { caPath: paths.ca, ca: ca.pem, key, cert }
}

function expiring(pem: string, days: number): boolean {
  return new Date(new X509Certificate(pem).validTo).getTime() - Date.now() < days * 86_400_000
}

function names(cert: X509Certificate, host: string): boolean {
  return isIP(host) ? cert.checkIP(host) !== undefined : cert.checkHost(host) !== undefined
}
