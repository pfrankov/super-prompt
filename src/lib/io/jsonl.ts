import type { DatasetItem } from '../types'

export interface ParsedRow {
  input: string
  expectedOutput?: string
  meta?: Record<string, string>
}

/** Streaming JSONL reader (returns all parsed rows). */
export async function readJsonlFile(file: File): Promise<ParsedRow[]> {
  const text = await file.text()
  return parseJsonl(text)
}

export function parseJsonl(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const row = coerceRow(obj)
      if (row) out.push(row)
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

function coerceRow(obj: Record<string, unknown>): ParsedRow | null {
  const input = obj.input ?? obj.prompt ?? obj.question
  if (typeof input !== 'string' || !input.trim()) return null
  const expected = obj.expectedOutput ?? obj.expected ?? obj.output ?? obj.answer
  const meta: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'input' || k === 'expectedOutput' || k === 'expected' || k === 'output' || k === 'answer' || k === 'prompt' || k === 'question') continue
    if (v == null) continue
    meta[k] = String(v)
  }
  return {
    input,
    expectedOutput: typeof expected === 'string' ? expected : undefined,
    meta: Object.keys(meta).length ? meta : undefined,
  }
}

export function toJsonl(items: Pick<DatasetItem, 'input' | 'expectedOutput' | 'meta'>[]): string {
  return items
    .map((it) => {
      const obj: Record<string, unknown> = { input: it.input }
      if (it.expectedOutput) obj.expectedOutput = it.expectedOutput
      if (it.meta) Object.assign(obj, it.meta)
      return JSON.stringify(obj)
    })
    .join('\n')
}