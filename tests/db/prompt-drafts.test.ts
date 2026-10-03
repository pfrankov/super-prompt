import { beforeEach, describe, expect, it } from 'vitest'
import { clearPromptDraft, readPromptDraft, stagePromptDraft } from '../../src/lib/db/prompt-drafts'
describe('prompt draft journal', () => {
  beforeEach(() => sessionStorage.clear())
  it('preserves an empty prompt and isolates tasks', () => {
    stagePromptDraft('a', '')
    expect(readPromptDraft('a')).toBe('')
    expect(readPromptDraft('b')).toBeNull()
  })
  it('an older completed save cannot erase newer text', () => {
    stagePromptDraft('a', 'new')
    clearPromptDraft('a', 'old')
    expect(readPromptDraft('a')).toBe('new')
    clearPromptDraft('a', 'new')
    expect(readPromptDraft('a')).toBeNull()
  })
})
