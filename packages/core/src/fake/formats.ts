import type { Faker as FakerJs } from '@faker-js/faker'
import type { Entity, Field } from '../source.js'
import { matchCase, shape, type Random } from './random.js'

export const FORMATS = [
  'email',
  'phone',
  'first_name',
  'last_name',
  'full_name',
  'street',
  'city',
  'postal_code',
  'country',
  'company',
  'username',
  'url',
  'iban',
  'text',
  'shape',
] as const

export type Format = (typeof FORMATS)[number]

/** Formats that describe a person: one person's email is the same fake in every field that holds it. */
export const PERSONAL: ReadonlySet<Format> = new Set([
  'email',
  'phone',
  'first_name',
  'last_name',
  'full_name',
  'street',
  'city',
  'postal_code',
])

const BY_NAME: [RegExp, Format][] = [
  [/^(e_?mail|.*_e_?mail|e_?mail_.*|mail)$/, 'email'],
  [/^(first_?name|given_?name|forename)$/, 'first_name'],
  [/^(last_?name|surname|family_?name)$/, 'last_name'],
  [/^(full_?name|display_?name|contact_?name|customer_?name|person_?name|author_?name)$/, 'full_name'],
  [/^(phone|.*_phone|phone_.*|mobile|telephone|tel|cell)$/, 'phone'],
  [/^(street|street_?address|address|address_?line_?\d|address\d|line_?\d)$/, 'street'],
  [/^(city|town)$/, 'city'],
  [/^(zip|zip_?code|postal_?code|post_?code)$/, 'postal_code'],
  [/^(country|country_?code)$/, 'country'],
  [/^(company|company_?name|organi[sz]ation|employer)$/, 'company'],
  [/^(username|user_?name|login|handle|nickname)$/, 'username'],
  [/^(url|website|homepage|web_?site|link)$/, 'url'],
  [/^iban$/, 'iban'],
]

/** Entities whose `name` column names a person. */
const PEOPLE = /^(users?|customers?|people|persons?|employees?|contacts?|authors?|members?|accounts?|profiles?|patients?|students?|staff|clients?)$/

/** The realistic format a field's name says, if any. The name only picks a format; it never lets a value pass. */
export function formatByName(field: Pick<Field, 'name'>, entity?: Pick<Entity, 'name'>): Format | undefined {
  const name = field.name.toLowerCase()
  for (const [pattern, format] of BY_NAME) if (pattern.test(name)) return format
  if (name === 'name' && entity && PEOPLE.test(entity.name.toLowerCase())) return 'full_name'
  return undefined
}

/** A fake in a format, shaped like the real value where the format allows. */
export function generate(format: Format, real: string, faker: FakerJs, random: Random): string {
  switch (format) {
    case 'email':
      return faker.internet.exampleEmail().toLowerCase()
    case 'phone':
      return phone(real, random)
    case 'first_name':
      return matchCase(real, faker.person.firstName())
    case 'last_name':
      return matchCase(real, faker.person.lastName())
    case 'full_name':
      return matchCase(real, faker.person.fullName())
    case 'street':
      return faker.location.streetAddress()
    case 'city':
      return matchCase(real, faker.location.city())
    case 'postal_code':
      return shape(real, random)
    case 'country':
      if (/^[A-Z]{2}$/.test(real)) return faker.location.countryCode('alpha-2')
      if (/^[A-Z]{3}$/.test(real)) return faker.location.countryCode('alpha-3')
      return faker.location.country()
    case 'company':
      return faker.company.name()
    case 'username':
      return faker.internet.username().toLowerCase()
    case 'url':
      return `https://www.example.com/${faker.lorem.slug(2)}`
    case 'iban':
      try {
        return faker.finance.iban({ formatted: /\s/.test(real), countryCode: real.slice(0, 2).toUpperCase() })
      } catch {
        return shape(real, random)
      }
    case 'text':
      return text(real, faker)
    case 'shape':
      return shape(real, random)
  }
}

/** Words of about the same length as the real text. */
export function text(real: string, faker: FakerJs): string {
  const words: string[] = []
  for (let length = -1; length < real.length; length += words.at(-1)!.length + 1) words.push(faker.lorem.word())
  const out = words.join(' ')
  return matchCase(real, out.charAt(0).toUpperCase() + out.slice(1))
}

/** Digits replaced, separators and a leading country code kept. */
function phone(real: string, random: Random): string {
  const code = /^\+\d{1,3}(?=[\s.-])/.exec(real)?.[0] ?? ''
  return code + shape(real.slice(code.length), random)
}
