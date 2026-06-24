import { describe, expect, it } from 'vitest'
import { canAutoReplaceExamples, generatedItemsFromAnalysis, parsePromptAnalysis, promptFingerprint } from '../../src/lib/improve/intake'
import type { DatasetItem } from '../../src/lib/types'

describe('prompt intake', () => {
  it('parses analysis JSON from a model response', () => {
    const parsed = parsePromptAnalysis(`
      Here is JSON:
      {"name":"Arithmetic","description":"Answer arithmetic only.","rubric":"Only final number.","examples":[{"input":"2+2?","expectedOutput":"4","notes":"basic","difficulty":"easy"}]}
    `)
    expect(parsed?.name).toBe('Arithmetic')
    expect(parsed?.examples[0]).toMatchObject({ input: '2+2?', expectedOutput: '4', difficulty: 'easy' })
  })

  it('stores generated metadata with the prompt fingerprint', () => {
    const fp = promptFingerprint('Return only numbers.')
    const items = generatedItemsFromAnalysis({
      name: 'N',
      description: 'D',
      rubric: 'R',
      examples: [{ input: '1+1?', expectedOutput: '2', notes: 'small', difficulty: 'easy' }],
    }, fp)
    expect(items[0].meta).toMatchObject({ source: 'generated', promptFingerprint: fp, notes: 'small', difficulty: 'easy' })
  })

  it('does not allow auto-replacing manual or edited examples', () => {
    const manual: DatasetItem[] = [{
      id: '1',
      datasetId: 'd',
      input: 'hello',
      meta: { source: 'generated', touched: 'manual', promptFingerprint: 'old' },
    }]
    const imported: DatasetItem[] = [{
      id: '2',
      datasetId: 'd',
      input: 'hello',
    }]
    expect(canAutoReplaceExamples(manual, 'next')).toBe(false)
    expect(canAutoReplaceExamples(imported, 'next')).toBe(false)
  })

  it('allows replacing stale generated examples', () => {
    const generated: DatasetItem[] = [{
      id: '1',
      datasetId: 'd',
      input: 'hello',
      meta: { source: 'generated', promptFingerprint: 'old' },
    }]
    expect(canAutoReplaceExamples(generated, 'next')).toBe(true)
  })
})
