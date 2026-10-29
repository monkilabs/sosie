// Every link and anchor inside the built site resolves, as a browser at the site's base would resolve it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dist = new URL('../dist/', import.meta.url).pathname
const site = 'https://monkilabs.github.io'
const base = '/sosie/'

const pages = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.html')) pages.push(path)
  }
}
walk(dist)

const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
const fileFor = (pathname) => {
  const file = join(dist, decodeURI(pathname).slice(base.length))
  if (existsSync(file) && statSync(file).isFile()) return file
  return existsSync(join(file, 'index.html')) ? join(file, 'index.html') : undefined
}

const broken = []
let count = 0
for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  const at = new URL(base + page.slice(dist.length).replace(/index\.html$/, '').replace(/\.html$/, '/'), site)
  for (const [, href] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = new URL(href, at)
    if (url.origin !== site) continue
    count++
    const where = `${at.pathname}: ${href}`
    if (!url.pathname.startsWith(base)) broken.push(`${where} is outside ${base}`)
    else if (!fileFor(url.pathname)) broken.push(`${where} has no page`)
    else if (url.hash && fileFor(url.pathname).endsWith('.html') && !ids(readFileSync(fileFor(url.pathname), 'utf8')).has(decodeURIComponent(url.hash.slice(1))))
      broken.push(`${where} has no such anchor`)
  }
}
for (const b of broken) console.error(`✗ ${b}`)
console.log(`${count} links in ${pages.length} pages, ${broken.length} broken`)
process.exit(broken.length ? 1 : 0)
