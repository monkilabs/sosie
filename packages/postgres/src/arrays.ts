import type { Value } from '@sosie/core'

/** Postgres array text, '{a,"b c",NULL}', to a list, and back. Text that is not an array throws, never loops. */
export function parseArray(text: string): { bounds: string; items: Value[] } {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('Not an array')
  const bounds = text.slice(0, start)
  let i = start
  const end = () => {
    if (i >= text.length) throw new Error('Not an array: it ends too soon')
  }
  const list = (): Value[] => {
    const items: Value[] = []
    i++ // {
    end()
    if (text[i] === '}') {
      i++
      return items
    }
    for (;;) {
      end()
      if (text[i] === '{') items.push(list())
      else if (text[i] === '"') {
        let value = ''
        i++
        for (end(); text[i] !== '"'; end()) {
          if (text[i] === '\\') i++
          end()
          value += text[i++]
        }
        i++
        items.push(value)
      } else {
        let stop = i
        while (stop < text.length && text[stop] !== ',' && text[stop] !== '}') stop++
        const raw = text.slice(i, stop).trim()
        items.push(raw.toUpperCase() === 'NULL' ? null : raw)
        i = stop
      }
      end()
      if (text[i] === ',') i++
      else if (text[i] === '}') {
        i++
        return items
      } else throw new Error('Not an array')
    }
  }
  const items = list()
  if (text.slice(i).trim()) throw new Error('Not an array: text after it')
  return { bounds, items }
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
