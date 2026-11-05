/** One range, as Postgres writes it: '[1,10)', '(,"2025-01-01 10:00:00+00"]'. A bound of null is infinite. */
export interface Range {
  lower: string | null
  upper: string | null
  open: '[' | '('
  close: ']' | ')'
}

/** Range text, or a multirange's ('{[1,3),[5,7)}'), to its ranges. Text that is neither throws, never loops. */
export function parseRanges(text: string): { multi: boolean; ranges: (Range | 'empty')[] } {
  if (text[0] !== '{') {
    const [range, end] = readRange(text, 0)
    if (end !== text.length) throw new Error('Not a range: text after it')
    return { multi: false, ranges: [range] }
  }
  const ranges: (Range | 'empty')[] = []
  let i = 1
  if (text[i] === '}' && i + 1 === text.length) return { multi: true, ranges }
  for (;;) {
    const [range, end] = readRange(text, i)
    ranges.push(range)
    if (text[end] === '}' && end + 1 === text.length) return { multi: true, ranges }
    if (text[end] !== ',') throw new Error('Not a multirange')
    i = end + 1
  }
}

/** Ranges back to text, each bound quoted where Postgres quotes one. */
export function serializeRanges(multi: boolean, ranges: (Range | 'empty')[]): string {
  const one = (r: Range | 'empty') => (r === 'empty' ? 'empty' : `${r.open}${bound(r.lower)},${bound(r.upper)}${r.close}`)
  return multi ? `{${ranges.map(one).join(',')}}` : one(ranges[0]!)
}

function bound(value: string | null): string {
  if (value === null) return ''
  return value === '' || /["\\(),[\]\s]/.test(value) ? `"${value.replace(/["\\]/g, (c) => c + c)}"` : value
}

function readRange(text: string, at: number): [Range | 'empty', number] {
  if (text.startsWith('empty', at)) return ['empty', at + 5]
  const open = text[at]
  if (open !== '[' && open !== '(') throw new Error('Not a range')
  let i = at + 1
  const read = (ends: string): string | null => {
    if (i >= text.length) throw new Error('Not a range: it ends too soon')
    if (ends.includes(text[i]!)) return null
    let value = ''
    if (text[i] !== '"') {
      while (i < text.length && !ends.includes(text[i]!)) value += text[i++]
      return value
    }
    for (i++; ; ) {
      if (i >= text.length) throw new Error('Not a range: a quote does not close')
      const ch = text[i]!
      if (ch === '\\' && i + 1 < text.length) {
        value += text[i + 1]
        i += 2
      } else if (ch === '"' && text[i + 1] === '"') {
        value += '"'
        i += 2
      } else if (ch === '"') {
        i++
        return value
      } else {
        value += ch
        i++
      }
    }
  }
  const lower = read(',')
  if (text[i] !== ',') throw new Error('Not a range: no comma')
  i++
  const upper = read('])')
  const close = text[i]
  if (close !== ']' && close !== ')') throw new Error('Not a range: it does not close')
  return [{ lower, upper, open, close }, i + 1]
}

/** Whether one bound comes after another, compared as their subtype compares them. */
export function after(a: string, b: string, kind: string): boolean {
  if (kind === 'integer' || kind === 'decimal') return Number(a) > Number(b)
  if (kind === 'date' || kind === 'datetime') {
    const time = (t: string) => Date.parse(`${t.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')}${/[Zz]|[+-]\d{2}(:?\d{2})?$/.test(t) || kind === 'date' ? '' : 'Z'}`)
    const [x, y] = [time(a), time(b)]
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x > y
  }
  return a > b
}
