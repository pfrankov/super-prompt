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
  /** Individual lines when bounded, otherwise at most two lossless raw text blocks. */
  lines: PromptDiffLine[]
  /** Physical source lines represented by the comparison, including coarse blocks. */
  lineCount: number
  coarse: boolean
  counts: Record<PromptDiffKind, number>
  /** False means unmatched sections were replaced without searching for inner matches. */
  exact: boolean
  comparedCells: number
  showLineEndings: boolean
}

export const PROMPT_DIFF_MAX_CELLS = 250_000
export const PROMPT_DIFF_MAX_CHARACTERS = 1_000_000
export const PROMPT_DIFF_MAX_LINES = 20_000
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

/** Count before tokenizing: even an all-newline input uses constant extra memory. */
function countLines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      count++
      if (text.charCodeAt(i + 1) === 10) i++
    } else if (code === 10) count++
  }
  return count + (text.length > 0 && !endingOf(text) ? 1 : 0)
}

function coarseDiff(before: string, after: string, oldCount: number, newCount: number, showLineEndings: boolean): PromptDiff {
  const same = before === after
  const counts = same
    ? { unchanged: oldCount, removed: 0, added: 0 }
    : { unchanged: 0, removed: oldCount, added: newCount }
  const lines: PromptDiffLine[] = []
  // Keep original strings, including every terminator. Consumers of the reading
  // view can concatenate these few blocks without iterating through source lines.
  if (same && before) lines.push({ kind: 'unchanged', text: before, ending: '', beforeLine: 1, afterLine: 1 })
  else {
    if (before) lines.push({ kind: 'removed', text: before, ending: '', beforeLine: 1, afterLine: null })
    if (after) lines.push({ kind: 'added', text: after, ending: '', beforeLine: null, afterLine: 1 })
  }
  return {
    lines,
    lineCount: counts.unchanged + counts.removed + counts.added,
    coarse: true,
    counts,
    // Equality, insertion, and deletion are known exactly without matching.
    exact: same || !before || !after,
    comparedCells: 0,
    showLineEndings,
  }
}

/**
 * Lossless line diff. Common edges are linear; the optional LCS is capped in both
 * work and allocation. Large replacements remain complete, with an honest flag
 * that their removal/addition counts may not be the smallest possible edit.
 */
export function diffPrompts(before: string, after: string): PromptDiff {
  const same = before === after
  const oldLineCount = countLines(before)
  const newLineCount = same ? oldLineCount : countLines(after)
  const showLineEndings = before.includes('\r') || after.includes('\r') || endingOf(before) !== endingOf(after)
  if (before.length + after.length > PROMPT_DIFF_MAX_CHARACTERS || oldLineCount + newLineCount > PROMPT_DIFF_MAX_LINES) {
    return coarseDiff(before, after, oldLineCount, newLineCount, showLineEndings)
  }
  const oldLines = splitLines(before)
  const newLines = same ? oldLines : splitLines(after)
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
    lineCount: lines.length,
    coarse: false,
    counts,
    exact,
    comparedCells,
    // Make otherwise invisible newline-only changes legible, without cluttering
    // ordinary LF-only edits whose final line-break state is unchanged.
    showLineEndings,
  }
}

export interface PromptDiffCursor {
  line: number
  offset: number
  /** Opaque coarse-page resume positions; retaining these avoids rescanning. */
  block?: number
  sourceOffset?: number
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
  if (diff.coarse) return getCoarsePage(diff, cursor)
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

function lineBreakLength(text: string, index: number): number {
  const code = text.charCodeAt(index)
  return code === 13 ? (text.charCodeAt(index + 1) === 10 ? 2 : 1) : code === 10 ? 1 : 0
}

/** Expand only the visible portion of raw blocks. No source-sized token array. */
function getCoarsePage(diff: PromptDiff, cursor: PromptDiffCursor): PromptDiffPage {
  const lines: PromptDiffDisplayLine[] = []
  let index = Math.max(0, Math.trunc(cursor.line) || 0)
  if (index >= diff.lineCount) return { lines, next: null }
  let offset = Math.max(0, Math.trunc(cursor.offset) || 0)
  let block = 0
  let blockStart = 0
  while (block < diff.lines.length && index >= blockStart + diff.counts[diff.lines[block].kind]) {
    blockStart += diff.counts[diff.lines[block].kind]
    block++
  }
  let position = 0
  if (cursor.block === block && cursor.sourceOffset !== undefined) {
    position = cursor.sourceOffset
  } else {
    // Direct line seeks are supported; normal Next/Previous resumes in O(page).
    const raw = diff.lines[block].text
    let sourceLine = blockStart
    while (sourceLine < index && position < raw.length) {
      const endingLength = lineBreakLength(raw, position)
      if (endingLength) { position += endingLength; sourceLine++ }
      else position++
    }
    const start = position
    while (position < raw.length && position - start < offset && !lineBreakLength(raw, position)) position++
    offset = position - start
  }

  let characters = 0
  while (block < diff.lines.length && lines.length < PROMPT_DIFF_PAGE_ROWS && characters < PROMPT_DIFF_PAGE_CHARACTERS) {
    const source = diff.lines[block]
    const raw = source.text
    const limit = Math.min(raw.length, position + PROMPT_DIFF_LINE_CHARACTERS, position + PROMPT_DIFF_PAGE_CHARACTERS - characters)
    let end = position
    while (end < limit && !lineBreakLength(raw, end)) end++
    if (end < raw.length && end > position && /[\uD800-\uDBFF]/.test(raw[end - 1]) && /[\uDC00-\uDFFF]/.test(raw[end])) end--
    const endingLength = lineBreakLength(raw, end)
    if (end === position && !endingLength && position < raw.length) break
    const text = raw.slice(position, end)
    const continues = end < raw.length && !endingLength
    const sourceLine = index - blockStart + 1
    lines.push({
      kind: source.kind,
      text,
      ending: raw.slice(end, end + endingLength) as PromptLineEnding,
      beforeLine: source.kind === 'added' ? null : sourceLine,
      afterLine: source.kind === 'removed' ? null : sourceLine,
      index,
      offset,
      continued: offset > 0,
      continues,
    })
    characters += text.length
    position = end + endingLength
    if (continues) offset += text.length
    else { index++; offset = 0 }
    if (position >= raw.length) { block++; blockStart = index; position = 0 }
  }
  return { lines, next: index < diff.lineCount ? { line: index, offset, block, sourceOffset: position } : null }
}
