import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const { version } = JSON.parse(read('packages/cli/package.json')) as { version: string }

/**
 * The README, in English and in each language it is translated into, by the name its language bar shows. A release
 * moves the version each one names, and a change to the English one's commands moves them in every translation: the
 * prose of a translation may trail, and says the English one is current.
 */
const TRANSLATIONS = [
  { file: 'i18n/README.es.md', name: 'Español' },
  { file: 'i18n/README.pt-BR.md', name: 'Português (Brasil)' },
  { file: 'i18n/README.fr.md', name: 'Français' },
  { file: 'i18n/README.de.md', name: 'Deutsch' },
  { file: 'i18n/README.zh-CN.md', name: '简体中文' },
]
const READMES = [{ file: 'README.md', name: 'English' }, ...TRANSLATIONS]

/** The language bar: every language, this one's in bold, each other linked from where this one is. */
const bar = (own: string) =>
  READMES.map(({ file, name }) => (file === own ? `**${name}**` : `[${name}](${relative(dirname(own), file)})`)).join(' · ')
const codeBlocks = (text: string) => text.match(/^```[^\n]*\n[\s\S]*?^```$/gm) ?? []
/** Every link and image that is not a URL or an anchor, as written. */
const relativeLinks = (text: string) =>
  [...text.matchAll(/\]\(([^)\s]+)\)|(?:src|srcset)="([^"]+)"/g)].map((m) => (m[1] ?? m[2])!).filter((target) => !/^(https?:|mailto:|#)/.test(target))

describe.each(READMES)('$file', ({ file }) => {
  it('opens with its language bar, under the logo', () => {
    expect(read(file)).toMatch(new RegExp(`^</h1>\\n\\n${bar(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n`, 'm'))
  })

  it('names the version of @sosie/cli that is on npm', () => {
    expect(read(file)).toMatch(new RegExp(`Sosie ${version.replaceAll('.', '\\.')}(?!\\.?\\d)`))
  })

  it('links only to files that are there', () => {
    const links = relativeLinks(read(file))
    expect(links.length).toBeGreaterThan(0)
    for (const target of links) expect(existsSync(join(root, dirname(file), target.split('#')[0]!)), target).toBe(true)
  })
})

describe.each(TRANSLATIONS)('$file', ({ file }) => {
  it('has the English README’s code blocks as they are, and its images', () => {
    expect(codeBlocks(read(file))).toEqual(codeBlocks(read('README.md')))
    expect(read(file).match(/<img [^>]+>/g)).toEqual(read('README.md').match(/<img [^>]+>/g)!.map((img) => img.replace('src="', 'src="../')))
  })

  it('says it is a translation of the English README, which is current', () => {
    expect(read(file)).toContain('](../README.md)')
  })
})
