import type { ArbitratorConfig, ProviderConfig } from '../types'
import { chatCompletionWithRetry } from '../api/openaiLike'
import { mutatorSystemPrompt } from './prompts/mutatorSystem'
import { tryParseJson } from './extract-json'
import { judgeRoute } from './judge'

export interface MutatorArgs {
  provider: ProviderConfig
  arbitrator?: ArbitratorConfig
  taskDescription: string
  rubric: string
  parentText: string
  parentScore: number | null
  childScore: number | null
  aggregatedFeedback: string
  temperature: number
}

export interface MutatorResult {
  newPrompt: string
  rationale: string
  tokensIn: number
  tokensOut: number
}

export async function runMutator(args: MutatorArgs): Promise<MutatorResult> {
  const userMsg = [
    'TASK:',
    args.taskDescription,
    '',
    'RUBRIC:',
    args.rubric,
    '',
    'CURRENT PROMPT (parent):',
    args.parentText,
    '',
    `PARENT SCORE: ${args.parentScore?.toFixed(2) ?? 'n/a'}`,
    `CHALLENGER SCORE: ${args.childScore?.toFixed(2) ?? 'n/a'}`,
    '',
    'AGGREGATED FEEDBACK FROM JUDGES:',
    args.aggregatedFeedback,
  ].join('\n')

  // The mutator always reuses the judge's model/route — keeping them on the
  // same endpoint means a single arbitrator override covers both roles.
  const route = judgeRoute(args.provider, args.arbitrator)
  const resp = await chatCompletionWithRetry({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    messages: [
      { role: 'system', content: mutatorSystemPrompt },
      { role: 'user', content: userMsg },
    ],
    temperature: args.temperature,
    maxTokens: 1500,
    timeoutMs: args.provider.requestTimeoutMs,
  }, args.provider.maxRetries)

  const parsed = tryParseJson<{ newPrompt?: string; rationale?: string }>(resp.text)
  if (!parsed || typeof parsed.newPrompt !== 'string' || !parsed.newPrompt.trim()) {
    return {
      newPrompt: args.parentText,
      rationale: 'mutator_parse_failed: kept parent text',
      tokensIn: resp.usage.promptTokens,
      tokensOut: resp.usage.completionTokens,
    }
  }
  return {
    newPrompt: parsed.newPrompt.trim(),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    tokensIn: resp.usage.promptTokens,
    tokensOut: resp.usage.completionTokens,
  }
}

/** Force a tiny swap mutation when mutator returns identical or empty text. */
export function forceVariation(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return text + '\n\nThink step by step before responding.'
  ;[lines[0], lines[1]] = [lines[1], lines[0]]
  return lines.join('\n')
}
