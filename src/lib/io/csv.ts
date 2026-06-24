import Papa from 'papaparse'
import type { ParsedRow } from './jsonl'
import { readJsonlFile } from './jsonl'

export async function readCsvFile(file: File): Promise<ParsedRow[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const out: ParsedRow[] = []
        for (const row of res.data) {
          const input = row.input ?? row.prompt ?? row.question ?? ''
          if (!input.trim()) continue
          const expected = row.expectedOutput ?? row.expected ?? row.output ?? row.answer ?? ''
          const meta: Record<string, string> = {}
          for (const [k, v] of Object.entries(row)) {
            if (['input', 'prompt', 'question', 'expectedOutput', 'expected', 'output', 'answer'].includes(k)) continue
            if (v == null) continue
            meta[k] = v
          }
          out.push({
            input,
            expectedOutput: expected || undefined,
            meta: Object.keys(meta).length ? meta : undefined,
          })
        }
        resolve(out)
      },
      error: reject,
    })
  })
}

export function toCsv(items: ParsedRow[]): string {
  const fields = new Set<string>(['input', 'expectedOutput'])
  for (const it of items) if (it.meta) for (const k of Object.keys(it.meta)) fields.add(k)
  return Papa.unparse(
    items.map((it) => {
      const row: Record<string, string> = {
        input: it.input,
        expectedOutput: it.expectedOutput ?? '',
      }
      if (it.meta) Object.assign(row, it.meta)
      return row
    }),
    { columns: Array.from(fields) }
  )
}

/** Auto-detect format from filename and parse. */
export async function readDatasetFile(file: File): Promise<ParsedRow[]> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return readJsonlFile(file)
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return readCsvFile(file)
  // Default to JSONL
  return readJsonlFile(file)
}