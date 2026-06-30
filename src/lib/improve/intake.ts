import type { DatasetItem, ProviderConfig } from '../types'
import { chatCompletion } from '../api/openaiLike'
import { tryParseJson } from '../optimizer/extract-json'

export interface PromptAnalysisExample {
  input: string
  expectedOutput?: string
  notes?: string
  difficulty?: string
}

export interface PromptAnalysis {
  name: string
  description: string
  rubric: string
  examples: PromptAnalysisExample[]
}

export interface AnalyzePromptArgs {
  provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'requestTimeoutMs' | 'modelRateLimits'>
  model: string
  prompt: string
  targetModel: string
  count?: number
  signal?: AbortSignal
}

const DEFAULT_COUNT = 8

export function promptFingerprint(prompt: string): string {
  let hash = 5381
  for (const ch of prompt.trim()) {
    hash = ((hash << 5) + hash) ^ ch.charCodeAt(0)
  }
  return (hash >>> 0).toString(36)
}

export function parsePromptAnalysis(text: string, count = DEFAULT_COUNT): PromptAnalysis | null {
  const parsed = tryParseJson<Record<string, unknown>>(text)
  if (!parsed) return null
  const examplesRaw = Array.isArray(parsed.examples) ? parsed.examples : []
  const examples = examplesRaw
    .map((row) => row && typeof row === 'object' ? row as Record<string, unknown> : null)
    .filter((row): row is Record<string, unknown> => !!row && typeof row.input === 'string' && row.input.trim().length > 0)
    .slice(0, count)
    .map((row) => ({
      input: String(row.input).trim(),
      expectedOutput: typeof row.expectedOutput === 'string' && row.expectedOutput.trim() ? row.expectedOutput.trim() : undefined,
      notes: typeof row.notes === 'string' && row.notes.trim() ? row.notes.trim() : undefined,
      difficulty: typeof row.difficulty === 'string' && row.difficulty.trim() ? row.difficulty.trim() : undefined,
    }))
  if (!examples.length) return null
  return {
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 80) : 'Prompt improvement',
    description: typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : 'Improve this system prompt for the selected target model.',
    rubric: typeof parsed.rubric === 'string' && parsed.rubric.trim()
      ? parsed.rubric.trim()
      : 'Score how well the answer follows the prompt, satisfies the user request, stays concise, and avoids unnecessary text.',
    examples,
  }
}

export function generatedItemsFromAnalysis(
  analysis: PromptAnalysis,
  fingerprint: string
): Omit<DatasetItem, 'id' | 'datasetId'>[] {
  return analysis.examples.map((example) => ({
    input: example.input,
    expectedOutput: example.expectedOutput,
    meta: {
      source: 'generated',
      promptFingerprint: fingerprint,
      ...(example.notes ? { notes: example.notes } : {}),
      ...(example.difficulty ? { difficulty: example.difficulty } : {}),
    },
  }))
}

export function examplesAreManual(items: DatasetItem[]): boolean {
  return items.some((item) => item.meta?.source !== 'generated' || item.meta?.touched === 'manual')
}

export function canAutoReplaceExamples(items: DatasetItem[], nextFingerprint: string): boolean {
  if (items.length === 0) return true
  if (examplesAreManual(items)) return false
  return items.some((item) => item.meta?.promptFingerprint !== nextFingerprint)
}

export async function analyzePrompt(args: AnalyzePromptArgs): Promise<PromptAnalysis> {
  const count = args.count ?? DEFAULT_COUNT
  const system = [
    'You prepare evaluation context for prompt optimization.',
    'Output ONLY valid JSON. No markdown fences. No prose.',
    'Schema: {"name": string, "description": string, "rubric": string, "examples": [{"input": string, "expectedOutput": string, "notes": string, "difficulty": "easy|normal|hard|edge"}]}.',
    'Infer the real user-facing task from the system prompt and preserve its domain, language, tone, safety constraints, and output format.',
    'Examples must be realistic user messages, not descriptions of tests and not meta-prompts about evaluating prompts.',
    'Create a balanced set: easy basics, normal production cases, hard multi-constraint cases, and edge cases with ambiguity, missing data, conflicting instructions, or format pressure.',
    'Use expectedOutput only when the correct answer is unambiguous and short enough to judge fairly; otherwise leave it out and explain the judging focus in notes.',
    'The rubric must be directly judgeable on a 0-10 scale. Include format adherence, completeness, factuality, constraint preservation, and penalties for hallucination or extra prose.',
  ].join(' ')
  const user = [
    `Target model: ${args.targetModel}`,
    `Produce exactly ${count} diverse eval examples.`,
    'Cover likely production inputs and common failure modes for this exact prompt.',
    'Do not leak the expected answer inside the input unless that is inherent to the real task.',
    'Avoid duplicates; each example should test a different behavior or risk.',
    '',
    'SYSTEM PROMPT:',
    args.prompt.trim(),
  ].join('\n')

  const response = await chatCompletion({
    baseUrl: args.provider.baseUrl,
    apiKey: args.provider.apiKey,
    model: args.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.4,
    maxTokens: 3000,
    timeoutMs: args.provider.requestTimeoutMs,
    signal: args.signal,
    rateLimits: args.provider.modelRateLimits,
  })
  const parsed = parsePromptAnalysis(response.text, count)
  if (!parsed) throw new Error('analysis_parse_failed')
  return parsed
}
