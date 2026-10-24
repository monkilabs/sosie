import type { Value } from '@sosie/core'

/** Postgres array text, '{a,"b c",NULL}', to a list, and back. */
export function parseArray(text: string): { bounds: string; items: Value[] } {
  const start = text.indexOf('{')
  const bounds = start > 0 ? text.slice(0, start) : ''
  let i = start
  const list = (): Value[] => {
    const items: Value[] = []
    i++ // {
    if (text[i] === '}') {
      i++
      return items
    }
    for (;;) {
      if (text[i] === '{') items.push(list())
      else if (text[i] === '"') {
        let value = ''
        i++
        while (text[i] !== '"') {
          if (text[i] === '\\') i++
          value += text[i++]
        }
        i++
        items.push(value)
      } else {
        let end = i
        while (text[end] !== ',' && text[end] !== '}') end++
        const raw = text.slice(i, end).trim()
        items.push(raw.toUpperCase() === 'NULL' ? null : raw)
        i = end
      }
      if (text[i] === ',') i++
      else if (text[i] === '}') {
        i++
        return items
      } else throw new Error(`Not an array: ${text.slice(0, 20)}`)
    }
  }
  return { bounds, items: list() }
}

export function serializeArray(items: Value[], bounds = ''): string {
  const item = (v: Value): string => {
    if (v === null) return 'NULL'
    if (Array.isArray(v)) return `{${v.map(item).join(',')}}`
    if (v === '' || /[{}",\\\s]/.test(v) || v.toUpperCase() === 'NULL') return `"${v.replace(/[\\"]/g, '\\$&')}"`
    return v
  }
  return bounds + item(items)
}
