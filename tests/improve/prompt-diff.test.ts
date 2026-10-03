import { describe, expect, it } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import PromptDiffView from '../../src/components/improve/PromptDiff.svelte'
import {
  diffPrompts,
  getPromptDiffPage,
  PROMPT_DIFF_MAX_CELLS,
  PROMPT_DIFF_MAX_LINES,
  PROMPT_DIFF_PAGE_CHARACTERS,
  PROMPT_DIFF_PAGE_ROWS,
  type PromptDiff,
  type PromptDiffCursor,
} from '../../src/lib/improve/prompt-diff'

function reconstruct(diff: PromptDiff, side: 'before' | 'after') {
  return diff.lines.filter((line) => line.kind !== (side === 'before' ? 'added' : 'removed'))
    .map((line) => line.text + line.ending).join('')
}

function expectLossless(before: string, after: string) {
  const diff = diffPrompts(before, after)
  expect(reconstruct(diff, 'before')).toBe(before)
  expect(reconstruct(diff, 'after')).toBe(after)
  expect(diff.counts.unchanged + diff.counts.removed + diff.counts.added).toBe(diff.lineCount)
  expect(diff.lines.length).toBeLessThanOrEqual(PROMPT_DIFF_MAX_LINES)
  expect(diff.comparedCells).toBeLessThanOrEqual(PROMPT_DIFF_MAX_CELLS)
  return diff
}

describe('prompt line diff', () => {
  it('reports the actual changed line with source and proposed line numbers', () => {
    const before = 'Summarize the message.\nKeep the request and deadline.'
    const after = 'Summarize the message.\nPreserve the request and explicit deadline. Do not add details.'
    const diff = expectLossless(before, after)
    expect(diff.counts).toEqual({ unchanged: 1, removed: 1, added: 1 })
    expect(diff.exact).toBe(true)
    expect(diff.lines.map(({ kind, beforeLine, afterLine }) => ({ kind, beforeLine, afterLine }))).toEqual([
      { kind: 'unchanged', beforeLine: 1, afterLine: 1 },
      { kind: 'removed', beforeLine: 2, afterLine: null },
      { kind: 'added', beforeLine: null, afterLine: 2 },
    ])
  })

  it.each([
    ['', '', { unchanged: 0, removed: 0, added: 0 }],
    ['', 'one\n\ntwo\n', { unchanged: 0, removed: 0, added: 3 }],
    ['one\n\ntwo\n', '', { unchanged: 0, removed: 3, added: 0 }],
    ['\n\n', '\n\n', { unchanged: 2, removed: 0, added: 0 }],
    ['same\n\nlast', 'same\n\nlast', { unchanged: 3, removed: 0, added: 0 }],
  ])('preserves empty and equal prompts (%j to %j)', (before, after, counts) => {
    expect(expectLossless(before, after).counts).toEqual(counts)
  })

  it.each([
    ['same', 'same\n'],
    ['same\n', 'same'],
    ['one\r\ntwo\r\n', 'one\ntwo\n'],
    ['\r\n\r\nlast', '\n\nlast\n'],
    ['one\rtwo\r', 'one\rtwo'],
    [' \t\n\n', ' \t\n'],
  ])('retains exact whitespace and line endings (%j to %j)', (before, after) => {
    expectLossless(before, after)
  })

  it('distinguishes trailing-newline and CRLF-only changes visibly', () => {
    expect(diffPrompts('same', 'same\n').showLineEndings).toBe(true)
    expect(diffPrompts('same\r\n', 'same\n').showLineEndings).toBe(true)
    expect(diffPrompts('old\nend', 'new\nend').showLineEndings).toBe(false)
  })

  it('aligns repeated and shifted lines without inventing changes', () => {
    const diff = expectLossless('repeat\nold\nrepeat\nstay\n', 'repeat\nrepeat\nnew\nstay\n')
    expect(diff.counts).toEqual({ unchanged: 3, removed: 1, added: 1 })
    expect(diff.lines.map((line) => line.kind)).toEqual(['unchanged', 'removed', 'unchanged', 'added', 'unchanged'])
  })

  it('reconstructs many mixed endings, blank lines, and repeated content', () => {
    let seed = 7
    const random = (max: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % max)
    const content = ['', 'same', 'same', 'αβ', '<script>', '\t  ', '🧭']
    const ending = ['\n', '\r\n', '\r']
    const prompt = () => Array.from({ length: random(30) }, () => content[random(content.length)] + ending[random(ending.length)]).join('') + content[random(content.length)]
    for (let i = 0; i < 200; i++) expectLossless(prompt(), prompt())
  })

  it('bounds detailed work for entirely replaced large inputs and keeps all content', () => {
    const before = Array.from({ length: 5000 }, (_, i) => `original ${i}\n`).join('')
    const after = Array.from({ length: 5000 }, (_, i) => `proposed ${i}\n`).join('')
    const diff = expectLossless(before, after)
    expect(diff.exact).toBe(false)
    expect(diff.comparedCells).toBe(0)
    expect(diff.counts).toEqual({ unchanged: 0, removed: 5000, added: 5000 })
  })

  it('still matches a small change within a long prompt in linear work', () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i}\n`)
    const before = lines.join('')
    lines[4000] = 'replacement\n'
    const diff = expectLossless(before, lines.join(''))
    expect(diff.exact).toBe(true)
    expect(diff.counts).toEqual({ unchanged: 9999, removed: 1, added: 1 })
    expect(diff.comparedCells).toBe(0)
  })

  it('marks fallback counts as conservative while retaining matched common edges', () => {
    const middle = Array.from({ length: 600 }, (_, i) => `repeat ${i}\n`).join('')
    const diff = expectLossless(`start\nbefore\n${middle}old\nend`, `start\nafter\n${middle}new\nend`)
    expect(diff.exact).toBe(false)
    expect(diff.counts).toEqual({ unchanged: 2, removed: 602, added: 602 })
  })

  it('avoids detailed matching for megabyte-sized repeated lines', () => {
    const shared = 'a'.repeat(300_000)
    const diff = expectLossless(`old\n${shared}\nend`, `new\n${shared}\nlast`)
    // Two copies together still fit; use longer lines to exercise the size cap.
    const large = expectLossless(`old\n${shared}${shared}\nend`, `new\n${shared}${shared}\nlast`)
    expect(diff.exact).toBe(true)
    expect(large.exact).toBe(false)
    expect(large.comparedCells).toBe(0)
  })

  it.each(['replace', 'equal', 'insert', 'delete'] as const)('bounds allocations for 250,000 short lines (%s)', (operation) => {
    const before = operation === 'insert' ? '' : 'a\n'.repeat(250_000)
    const after = operation === 'delete' ? '' : operation === 'replace' ? 'b\n'.repeat(250_000) : 'a\n'.repeat(250_000)
    const diff = expectLossless(before, after)
    expect(diff.coarse).toBe(true)
    expect(diff.lines.length).toBeLessThanOrEqual(2)
    expect(diff.comparedCells).toBe(0)
    expect(diff.exact).toBe(operation !== 'replace')
    expect(diff.lineCount).toBe(operation === 'replace' ? 500_000 : 250_000)
    // The reading-view consumer sees at most two raw blocks, not one entry per
    // line, and still receives the complete proposed text including terminators.
    expect(diff.lines.filter((line) => line.kind !== 'removed').map((line) => line.text + line.ending).join('')).toBe(after)
    const finalPage = getPromptDiffPage(diff, { line: diff.lineCount - 1, offset: 0 })
    expect(finalPage.lines).toHaveLength(1)
    expect(finalPage.next).toBeNull()
    expect(finalPage.lines[0].index).toBe(diff.lineCount - 1)
  })

  it('switches to coarse storage before exceeding the total source-line cap', () => {
    const before = 'a\n'.repeat(PROMPT_DIFF_MAX_LINES / 2)
    const atLimit = diffPrompts(before, 'b\n'.repeat(PROMPT_DIFF_MAX_LINES / 2))
    expect(atLimit.coarse).toBe(false)
    expect(atLimit.lines).toHaveLength(PROMPT_DIFF_MAX_LINES)
    const beyondLimit = expectLossless(before, 'b\n'.repeat(PROMPT_DIFF_MAX_LINES / 2 + 1))
    expect(beyondLimit.coarse).toBe(true)
    expect(beyondLimit.lines).toHaveLength(2)
  })
})

describe('bounded prompt diff pages', () => {
  it('paginates every blank line without dropping or duplicating content', () => {
    const diff = diffPrompts('', '\n'.repeat(2500))
    let cursor: PromptDiffCursor | null = { line: 0, offset: 0 }
    const seen: number[] = []
    while (cursor) {
      const page = getPromptDiffPage(diff, cursor)
      expect(page.lines.length).toBeLessThanOrEqual(PROMPT_DIFF_PAGE_ROWS)
      seen.push(...page.lines.map((line) => line.index))
      cursor = page.next
    }
    expect(seen).toEqual(Array.from({ length: 2500 }, (_, i) => i))
  })

  it('pages enormous Unicode lines within row and character budgets, losslessly', () => {
    const before = 'old\r\n' + '🧭a'.repeat(40_000) + '\r\n'
    const after = 'new\n' + '🧭b'.repeat(40_000) + '\n'
    const diff = diffPrompts(before, after)
    let cursor: PromptDiffCursor | null = { line: 0, offset: 0 }
    let oldText = ''
    let newText = ''
    let pages = 0
    while (cursor) {
      const page = getPromptDiffPage(diff, cursor)
      expect(page.lines.length).toBeGreaterThan(0)
      expect(page.lines.length).toBeLessThanOrEqual(PROMPT_DIFF_PAGE_ROWS)
      expect(page.lines.reduce((n, line) => n + line.text.length, 0)).toBeLessThanOrEqual(PROMPT_DIFF_PAGE_CHARACTERS)
      for (const line of page.lines) {
        expect(line.text.isWellFormed()).toBe(true)
        if (line.kind !== 'added') oldText += line.text + line.ending
        if (line.kind !== 'removed') newText += line.text + line.ending
      }
      cursor = page.next
      expect(++pages).toBeLessThan(20)
    }
    expect(pages).toBeGreaterThan(1)
    expect(oldText).toBe(before)
    expect(newText).toBe(after)
  })

  it('returns an empty bounded page for empty input or a cursor beyond the end', () => {
    expect(getPromptDiffPage(diffPrompts('', ''))).toEqual({ lines: [], next: null })
    expect(getPromptDiffPage(diffPrompts('', 'text'), { line: 10, offset: 0 })).toEqual({ lines: [], next: null })
  })

  it('pages coarse blocks across blank lines, mixed endings, and the removed/added boundary losslessly', () => {
    const before = 'old\r\n\r\n'.repeat(6000) + 'last old'
    const after = '\nnew\rblank\n'.repeat(6000) + 'last new\r\n'
    const diff = expectLossless(before, after)
    expect(diff.coarse).toBe(true)
    let cursor: PromptDiffCursor | null = { line: 0, offset: 0 }
    let reconstructedBefore = ''
    let reconstructedAfter = ''
    let lineCount = 0
    while (cursor) {
      const page = getPromptDiffPage(diff, cursor)
      expect(page.lines.length).toBeGreaterThan(0)
      expect(page.lines.length).toBeLessThanOrEqual(PROMPT_DIFF_PAGE_ROWS)
      for (const line of page.lines) {
        expect(line.index).toBe(lineCount++)
        if (line.kind !== 'added') reconstructedBefore += line.text + line.ending
        if (line.kind !== 'removed') reconstructedAfter += line.text + line.ending
      }
      cursor = page.next
    }
    expect(reconstructedBefore).toBe(before)
    expect(reconstructedAfter).toBe(after)
    expect(lineCount).toBe(diff.lineCount)
    const boundary = getPromptDiffPage(diff, { line: diff.counts.removed - 1, offset: 0 })
    expect(boundary.lines[0]).toMatchObject({ kind: 'removed', text: 'last old', beforeLine: 12001, afterLine: null })
    expect(boundary.lines[1]).toMatchObject({ kind: 'added', text: '', ending: '\n', beforeLine: null, afterLine: 1 })
  })

  it('resumes coarse long-line pages without splitting Unicode or losing final CRLF', () => {
    const before = '🧭a'.repeat(180_000) + '\r\nlast old'
    const after = '🧭b'.repeat(180_000) + '\rlast new\n'
    const diff = diffPrompts(before, after)
    expect(diff.coarse).toBe(true)
    let cursor: PromptDiffCursor | null = { line: 0, offset: 0 }
    let oldText = ''
    let newText = ''
    let previousCursor: PromptDiffCursor | null = null
    while (cursor) {
      const page = getPromptDiffPage(diff, cursor)
      expect(page.lines.length).toBeGreaterThan(0)
      expect(page.lines.length).toBeLessThanOrEqual(PROMPT_DIFF_PAGE_ROWS)
      expect(page.lines.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(PROMPT_DIFF_PAGE_CHARACTERS)
      for (const line of page.lines) {
        expect(line.text.isWellFormed()).toBe(true)
        if (line.kind !== 'added') oldText += line.text + line.ending
        if (line.kind !== 'removed') newText += line.text + line.ending
      }
      previousCursor = cursor
      cursor = page.next
      expect(cursor).not.toEqual(previousCursor)
    }
    expect(oldText).toBe(before)
    expect(newText).toBe(after)
  })
})

describe('prompt diff accessible markup', () => {
  it('labels added/removed content beyond color and escapes prompt HTML', async () => {
    const container = document.createElement('div')
    const component = mount(PromptDiffView, { target: container, props: { before: 'same\n<script>old</script>', after: 'same\n<img src=x onerror=alert(1)>' } })
    flushSync()
    expect(container.querySelector('[data-testid="prompt-diff"]')?.getAttribute('aria-label')).toBe('Changes to prompt')
    const summary = container.querySelector('[data-testid="prompt-diff-summary"]')
    expect(summary?.getAttribute('data-unchanged')).toBe('1')
    expect(summary?.getAttribute('data-removed')).toBe('1')
    expect(summary?.getAttribute('data-added')).toBe('1')
    expect(container.querySelector('[data-kind="removed"]')?.textContent).toContain('removed.')
    expect(container.querySelector('[data-kind="added"]')?.textContent).toContain('added.')
    expect(container.querySelector('script, img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    await unmount(component)
  })

  it('renders only a fixed page and discloses the conservative comparison', async () => {
    const before = Array.from({ length: 5000 }, (_, i) => `old ${i}\n`).join('')
    const after = Array.from({ length: 5000 }, (_, i) => `new ${i}\n`).join('')
    const container = document.createElement('div')
    const component = mount(PromptDiffView, { target: container, props: { before, after } })
    flushSync()
    expect(container.querySelectorAll('[data-testid="prompt-diff-row"]')).toHaveLength(PROMPT_DIFF_PAGE_ROWS)
    expect(container.querySelector('[data-testid="prompt-diff-limited"]')?.textContent).toContain('counts describe this comparison')
    expect(container.querySelector('[data-testid="prompt-diff-pagination"]')?.textContent).toContain('1–200 of 10000')
    expect(container.querySelector('[data-testid="prompt-diff-next"]')?.hasAttribute('disabled')).toBe(false)
    expect(container.querySelector('[data-testid="prompt-diff-previous"]')?.hasAttribute('disabled')).toBe(true)
    const next = container.querySelector<HTMLButtonElement>('[data-testid="prompt-diff-next"]')!
    flushSync(() => next.click())
    expect(container.querySelectorAll('[data-testid="prompt-diff-row"]')).toHaveLength(PROMPT_DIFF_PAGE_ROWS)
    expect(container.querySelector('[data-testid="prompt-diff-pagination"]')?.textContent).toContain('201–400 of 10000')
    expect(container.querySelector('[data-testid="prompt-diff-row"] .line-text')?.textContent).toBe('old 200')
    const previous = container.querySelector<HTMLButtonElement>('[data-testid="prompt-diff-previous"]')!
    flushSync(() => previous.click())
    expect(container.querySelector('[data-testid="prompt-diff-row"] .line-text')?.textContent).toBe('old 0')
    await unmount(component)
  })

  it.each([false, true])('keeps coarse rendering bounded and distinguishes matching limits from pagination (equal=%s)', async (equal) => {
    const before = '\n'.repeat(250_000)
    const after = equal ? before : 'x\n'.repeat(250_000)
    const container = document.createElement('div')
    const component = mount(PromptDiffView, { target: container, props: { before, after } })
    flushSync()
    const root = container.querySelector('[data-testid="prompt-diff"]')!
    expect(root.getAttribute('data-coarse')).toBe('true')
    expect(root.getAttribute('data-exact')).toBe(String(equal))
    expect(!!container.querySelector('[data-testid="prompt-diff-limited"]')).toBe(!equal)
    expect(container.querySelectorAll('[data-testid="prompt-diff-row"]')).toHaveLength(PROMPT_DIFF_PAGE_ROWS)
    expect(container.querySelector('[data-testid="prompt-diff-pagination"]')?.textContent).toContain(`1–200 of ${equal ? 250000 : 500000}`)
    const next = container.querySelector<HTMLButtonElement>('[data-testid="prompt-diff-next"]')!
    flushSync(() => next.click())
    expect(container.querySelectorAll('[data-testid="prompt-diff-row"]')).toHaveLength(PROMPT_DIFF_PAGE_ROWS)
    expect(container.querySelector('[data-testid="prompt-diff-pagination"]')?.textContent).toContain(`201–400 of ${equal ? 250000 : 500000}`)
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="prompt-diff-previous"]')!.click())
    expect(container.querySelector('[data-testid="prompt-diff-pagination"]')?.textContent).toContain(`1–200 of ${equal ? 250000 : 500000}`)
    await unmount(component)
  })
})
