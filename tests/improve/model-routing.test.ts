import { describe, expect, it, vi } from 'vitest'
import { isRunnableProvider, listProviderModels, providerKindFromBaseUrl, selectJudgeModel } from '../../src/lib/improve/model-routing'

describe('model routing', () => {
  it('treats mock providers as local runnable providers', async () => {
    global.fetch = vi.fn()

    const provider = { baseUrl: 'mock://super-prompt', apiKey: '' }
    await expect(listProviderModels(provider)).resolves.toContain('mock-judge')
    expect(isRunnableProvider(provider)).toBe(true)
    expect(providerKindFromBaseUrl(provider.baseUrl)).toBe('local')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('prefers a stronger mock judge over the target model', () => {
    const selection = selectJudgeModel(['mock-target', 'mock-judge'], 'mock-target', 'local')
    expect(selection.model).toBe('mock-judge')
    expect(selection.fallback).toBe(false)
  })
})
