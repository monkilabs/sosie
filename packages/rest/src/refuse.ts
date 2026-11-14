/**
 * sosie.yml's `refuse`: paths Sosie never sends a request to, each with every path under it, so `/billing/portal`
 * refuses `/billing/portal/session` too. A segment `*` or `{name}` is any one segment; a `*` within a segment is any
 * text (`export*`). A segment compares without its case and its `;params`, and decoded once and twice, as servers
 * and the proxies before them may read it: refusing a path must never be undone by how it is written.
 */
export function refuser(patterns: readonly string[]): (segments: readonly string[]) => boolean {
  const compiled = patterns.map((pattern) => pattern.split('/').filter(Boolean).map(segmentTest))
  return (segments) => {
    const forms = segments.map(formsOf)
    return compiled.some((pattern) => pattern.length <= forms.length && pattern.every((test, i) => forms[i]!.some(test)))
  }
}

/** How a pattern's segment tests one of a path's. */
function segmentTest(segment: string): (form: string) => boolean {
  if (segment === '*' || /^\{[^}]*\}$/.test(segment)) return () => true
  const text = decoded(segment)
  const pattern = new RegExp(`^${text.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
  return (form) => pattern.test(form)
}

/** A path's segment, decoded once already, as servers may read it: as it is, and decoded again; each without ;params. */
function formsOf(segment: string): string[] {
  return [...new Set([segment, decoded(segment)].map((form) => form.split(';')[0]!))]
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
