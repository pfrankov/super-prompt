import { describe, it, expect } from 'vitest'
import { parseJsonl, toJsonl, readJsonlFile } from '../../src/lib/io/jsonl'

describe('jsonl', () => {
  it('parses a basic JSONL stream', () => {
    const text = [
      JSON.stringify({ input: 'a', expectedOutput: 'A' }),
      JSON.stringify({ input: 'b', expectedOutput: 'B' }),
    ].join('\n')
    const out = parseJsonl(text)
    expect(out).toHaveLength(2)
    expect(out[0].input).toBe('a')
    expect(out[0].expectedOutput).toBe('A')
  })

  it('skips blank and malformed lines', () => {
    const text = [
      JSON.stringify({ input: 'a' }),
      '',
      'not json',
      JSON.stringify({ input: 'b' }),
    ].join('\n')
    const out = parseJsonl(text)
    expect(out).toHaveLength(2)
  })

  it('preserves extra meta keys', () => {
    const out = parseJsonl(JSON.stringify({ input: 'a', difficulty: 'hard' }))
    expect(out[0].meta).toEqual({ difficulty: 'hard' })
  })

  it('roundtrips via toJsonl', () => {
    const items = [
      { input: 'a', expectedOutput: 'A' },
      { input: 'b', expectedOutput: 'B', meta: { tag: 'x' } },
    ]
    const text = toJsonl(items)
    const back = parseJsonl(text)
    expect(back).toHaveLength(2)
    expect(back[1].meta?.tag).toBe('x')
  })

  it('rejects rows without input', () => {
    const out = parseJsonl(JSON.stringify({ expectedOutput: 'A' }))
    expect(out).toHaveLength(0)
  })
})