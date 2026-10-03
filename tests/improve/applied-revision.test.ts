import { beforeEach, describe, expect, it } from 'vitest'
import { readAppliedRevision, storeAppliedRevision } from '../../src/lib/improve/applied-revision'

describe('applied revision undo', () => {
  beforeEach(() => sessionStorage.clear())
  it('restores exact original bytes after reload and isolates prompts', () => {
    const revision = { before: '  original\r\n\n', after: 'new\n' }
    storeAppliedRevision('a', revision)
    expect(readAppliedRevision('a', 'new\n')).toEqual(revision)
    expect(readAppliedRevision('b', 'new\n')).toBeNull()
  })
  it('never offers stale undo over edits, including whitespace changes', () => {
    storeAppliedRevision('a', { before: 'old', after: 'new' })
    expect(readAppliedRevision('a', 'new ')).toBeNull()
    storeAppliedRevision('a', null)
    expect(readAppliedRevision('a', 'new')).toBeNull()
  })
  it('ignores corrupt records and keeps empty originals', () => {
    sessionStorage.setItem('sp.applied-revision.a', '{')
    expect(readAppliedRevision('a', 'new')).toBeNull()
    storeAppliedRevision('a', { before: '', after: 'new' })
    expect(readAppliedRevision('a', 'new')?.before).toBe('')
  })
})
