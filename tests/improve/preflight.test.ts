import { describe, expect, it } from 'vitest'
import { nextPreflightAction, preflightReady, type PreflightStep } from '../../src/lib/improve/preflight'

describe('preflight status mapping', () => {
  it('is ready when there are no failing steps', () => {
    const steps: PreflightStep[] = [
      { key: 'provider', status: 'ok', message: 'ok', action: '' },
      { key: 'judgeJson', status: 'warn', message: 'fallback', action: 'Pick a stronger judge.' },
    ]
    expect(preflightReady(steps)).toBe(true)
    expect(nextPreflightAction(steps)).toBe('Pick a stronger judge.')
  })

  it('blocks on the first failing step action', () => {
    const steps: PreflightStep[] = [
      { key: 'provider', status: 'ok', message: 'ok', action: '' },
      { key: 'target', status: 'fail', message: 'empty', action: 'Choose another target.' },
      { key: 'judgeJson', status: 'warn', message: 'fallback', action: 'Pick a stronger judge.' },
    ]
    expect(preflightReady(steps)).toBe(false)
    expect(nextPreflightAction(steps)).toBe('Choose another target.')
  })
})
