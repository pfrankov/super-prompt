/** Extract first balanced JSON object from a string. Tolerant of prose and code fences. */
export function extractFirstJson(text: string): string | null {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return null
}

export function tryParseJson<T = unknown>(text: string): T | null {
  const block = extractFirstJson(text)
  if (!block) return null
  try {
    return JSON.parse(block) as T
  } catch {
    return null
  }
}