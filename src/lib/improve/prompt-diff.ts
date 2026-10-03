export type PromptDiffKind = 'unchanged' | 'removed' | 'added'
export type PromptLineEnding = '' | '\n' | '\r\n' | '\r'

export interface PromptDiffLine {
  kind: PromptDiffKind
  text: string
  ending: PromptLineEnding
  beforeLine: number | null
  afterLine: number | null
}

export interface PromptDiff {
  lines: PromptDiffLine[]
  counts: Record<PromptDiffKind, number>
  /** False means unmatched sections were replaced without searching for inner matches. */
  exact: boolean
  comparedCells: number
  showLineEndings: boolean
}

export const PROMPT_DIFF_MAX_CELLS = 250_000
export const PROMPT_DIFF_MAX_CHARACTERS = 1_000_000
export const PROMPT_DIFF_PAGE_ROWS = 200
export const PROMPT_DIFF_PAGE_CHARACTERS = 32_000
export const PROMPT_DIFF_LINE_CHARACTERS = 2_000

/** Keep terminators on each token: joining the result reproduces the input byte-for-byte. */
function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function endingOf(line: string): PromptLineEnding {
  if (line.endsWith('\r\n')) return '\r\n'
  if (line.endsWith('\n')) return '\n'
  if (line.endsWith('\r')) return '\r'
  return ''
}

/**
 * Lossless line diff. Common edges are linear; the optional LCS is capped in both
 * work and allocation. Large replacements remain complete, with an honest flag
 * that their removal/addition counts may not be the smallest possible edit.
 */
export function diffPrompts(before: string, after: string): PromptDiff {
  const oldLines = splitLines(before)
  const newLines = before === after ? oldLines : splitLines(after)
  const lines: PromptDiffLine[] = []
  const counts = { unchanged: 0, removed: 0, added: 0 }
  let beforeLine = 1
  let afterLine = 1
  let exact = true
  let comparedCells = 0

  function append(kind: PromptDiffKind, raw: string) {
    const ending = endingOf(raw)
    lines.push({
      kind,
      text: ending ? raw.slice(0, -ending.length) : raw,
      ending,
      beforeLine: kind === 'added' ? null : beforeLine++,
      afterLine: kind === 'removed' ? null : afterLine++,
    })
    counts[kind]++
  }

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    append('unchanged', oldLines[prefix++])
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  const oldCount = oldEnd - prefix
  const newCount = newEnd - prefix
  const cells = oldCount * newCount
  if (oldCount === 0 || newCount === 0 || (oldCount === 1 && newCount === 1)) {
    for (let i = prefix; i < oldEnd; i++) append('removed', oldLines[i])
    for (let i = prefix; i < newEnd; i++) append('added', newLines[i])
  } else if (cells > PROMPT_DIFF_MAX_CELLS || before.length + after.length > PROMPT_DIFF_MAX_CHARACTERS) {
    exact = false
    for (let i = prefix; i < oldEnd; i++) append('removed', oldLines[i])
    for (let i = prefix; i < newEnd; i++) append('added', newLines[i])
  } else {
    // Intern once so long/repeated lines do not multiply string-comparison cost.
    const ids = new Map<string, number>()
    function id(raw: string) {
      let value = ids.get(raw)
      if (value === undefined) {
        value = ids.size
        ids.set(raw, value)
      }
      return value
    }
    const oldIds = oldLines.slice(prefix, oldEnd).map(id)
    const newIds = newLines.slice(prefix, newEnd).map(id)
    const width = newCount + 1
    const lcs = new Uint32Array((oldCount + 1) * width)
    for (let i = oldCount - 1; i >= 0; i--) {
      for (let j = newCount - 1; j >= 0; j--) {
        lcs[i * width + j] = oldIds[i] === newIds[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
      }
    }
    comparedCells = cells
    let i = 0
    let j = 0
    while (i < oldCount || j < newCount) {
      if (i < oldCount && j < newCount && oldIds[i] === newIds[j]) {
        append('unchanged', oldLines[prefix + i++])
        j++
      } else if (i < oldCount && (j === newCount || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
        append('removed', oldLines[prefix + i++])
      } else {
        append('added', newLines[prefix + j++])
      }
    }
  }

  for (let i = oldEnd; i < oldLines.length; i++) append('unchanged', oldLines[i])
  return {
    lines,
    counts,
    exact,
    comparedCells,
    // Make otherwise invisible newline-only changes legible, without cluttering
    // ordinary LF-only edits whose final line-break state is unchanged.
    showLineEndings: before.includes('\r') || after.includes('\r')
      || endingOf(oldLines.at(-1) ?? '') !== endingOf(newLines.at(-1) ?? ''),
  }
}

export interface PromptDiffCursor {
  line: number
  offset: number
}

export interface PromptDiffDisplayLine extends PromptDiffLine {
  index: number
  offset: number
  continued: boolean
  continues: boolean
}

export interface PromptDiffPage {
  lines: PromptDiffDisplayLine[]
  next: PromptDiffCursor | null
}

/** A fixed-size window, including character limits for single enormous lines. */
export function getPromptDiffPage(diff: PromptDiff, cursor: PromptDiffCursor = { line: 0, offset: 0 }): PromptDiffPage {
  const lines: PromptDiffDisplayLine[] = []
  let index = Math.max(0, Math.trunc(cursor.line) || 0)
  let offset = Math.max(0, Math.trunc(cursor.offset) || 0)
  let characters = 0
  while (index < diff.lines.length && lines.length < PROMPT_DIFF_PAGE_ROWS && characters < PROMPT_DIFF_PAGE_CHARACTERS) {
    const line = diff.lines[index]
    offset = Math.min(offset, line.text.length)
    let end = Math.min(line.text.length, offset + PROMPT_DIFF_LINE_CHARACTERS, offset + PROMPT_DIFF_PAGE_CHARACTERS - characters)
    // Do not show half an emoji on either side of a page/chunk boundary.
    if (end < line.text.length && end > offset && /[\uD800-\uDBFF]/.test(line.text[end - 1])) end--
    if (end === offset && offset < line.text.length) break
    const text = line.text.slice(offset, end)
    const continues = end < line.text.length
    lines.push({ ...line, text, index, offset, continued: offset > 0, continues, ending: continues ? '' : line.ending })
    characters += text.length
    if (continues) offset = end
    else {
      index++
      offset = 0
    }
  }
  return { lines, next: index < diff.lines.length ? { line: index, offset } : null }
}
