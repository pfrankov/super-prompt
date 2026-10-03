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

import { isRunnableModelSetup } from '../../src/lib/improve/model-routing'
const target = { baseUrl: 'https://target.example/v1', apiKey: 'synthetic', targetModel: 'target', judgeModel: '' }
const arbiter = { enabled: true, baseUrl: 'https://judge.example/v1', apiKey: 'synthetic', model: 'judge' }
it('accepts a standalone arbiter without an unused primary judge', () => {
  expect(isRunnableModelSetup(target, arbiter)).toBe(true)
  expect(isRunnableModelSetup(target, {...arbiter, enabled:false})).toBe(false)
})
it.each([
  {baseUrl:''}, {baseUrl:'not a URL'}, {baseUrl:'file:///tmp/model'}, {apiKey:''}, {model:''},
])('rejects an enabled but unusable arbiter route %j', (patch) => {
  expect(isRunnableModelSetup({...target,judgeModel:'fallback'}, {...arbiter,...patch})).toBe(false)
})
it('accepts keyless local and demo arbiters including IPv6 localhost', () => {
  for(const baseUrl of ['http://127.0.0.1:11434/v1','http://[::1]:11434/v1','mock://super-prompt']) {
    expect(isRunnableModelSetup(target,{...arbiter,baseUrl,apiKey:''})).toBe(true)
  }
})
