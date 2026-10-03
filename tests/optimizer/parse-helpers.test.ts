import { describe, it, expect } from 'vitest'

import { extractFirstJson, tryParseJson } from '../../src/lib/optimizer/extract-json'

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
  it('preserves Markdown fences inside JSON string values', () => {
    const newPrompt = 'Return a Markdown block: ```json\n{"result": true}\n```'
    const text = JSON.stringify({ newPrompt, rationale: 'Keep ``` fences' })
    expect(tryParseJson(text)).toEqual({ newPrompt, rationale: 'Keep ``` fences' })
    expect(tryParseJson(`\`\`\`json\n${text}\n\`\`\``)).toEqual({ newPrompt, rationale: 'Keep ``` fences' })
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
