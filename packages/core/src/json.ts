/** JSON.rawJSON and JSON.isRawJSON: Node has them, and es2024's types do not. */
const raw = JSON as unknown as { rawJSON(text: string): object; isRawJSON(value: unknown): value is { rawJSON: string } }

/**
 * JSON parsed with each integer beyond 2^53 kept as written, as raw JSON: a
 * 64-bit id read as a number would round, and its fake would name nothing.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '') ? raw.rawJSON(context!.source!) : value,
  )
}

/** The digits of an integer `parseJson` kept as written; undefined for any other value. */
export function exactInteger(value: unknown): string | undefined {
  return raw.isRawJSON(value) ? value.rawJSON : undefined
}

/** An integer that JSON.stringify writes as these digits, however many. */
export function integerOf(digits: string): unknown {
  return raw.rawJSON(digits)
}
