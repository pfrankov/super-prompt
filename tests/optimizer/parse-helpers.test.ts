import { describe, it, expect } from 'vitest'

/** Extract first balanced JSON object from a string. Tolerant of prose/fences. */
export function extractFirstJson(text: string): string | null {
  // strip code fences
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return null
}

describe('extractFirstJson', () => {
  it('parses plain JSON', () => {
    const out = extractFirstJson('{"a":1,"b":2}')
    expect(JSON.parse(out!)).toEqual({ a: 1, b: 2 })
  })
  it('strips code fences', () => {
    const out = extractFirstJson('```json\n{"a":1}\n```')
    expect(JSON.parse(out!)).toEqual({ a: 1 })
  })
  it('skips leading prose', () => {
    const out = extractFirstJson('Sure! Here is the JSON:\n{"a":1}')
    expect(JSON.parse(out!)).toEqual({ a: 1 })
  })
  it('returns null for no JSON', () => {
    expect(extractFirstJson('no json here')).toBeNull()
  })
  it('handles nested braces', () => {
    const out = extractFirstJson('{"a":{"b":1},"c":[1,2]}')
    expect(JSON.parse(out!)).toEqual({ a: { b: 1 }, c: [1, 2] })
  })
  it('handles strings with braces', () => {
    const out = extractFirstJson('{"a":"x{y}z"}')
    expect(JSON.parse(out!)).toEqual({ a: 'x{y}z' })
  })
})
