import type { ArbitratorConfig, JudgeVerdict, ProviderConfig, Winner } from '../types'
import { chatCompletionWithRetry } from '../api/openaiLike'
import { judgeSystemPrompt } from './prompts/judgeSystem'
import { tryParseJson } from './extract-json'

export interface JudgeArgs {
  provider: ProviderConfig
  arbitrator?: ArbitratorConfig
  taskDescription: string
  rubric: string
  input: string
  outputA: string
  outputB: string
  expectedOutput?: string
  temperature: number
}

export interface JudgeResult {
  verdict: JudgeVerdict
  tokensIn: number
  tokensOut: number
  latencyMs: number
}

function coerceWinner(v: unknown): Winner {
  const x = String(v ?? '').toUpperCase()
  if (x === 'A') return 'A'
  if (x === 'B') return 'B'
  return 'tie'
}

/** Pick the route (URL/key/model) the judge should call. Arbitrator wins when
 *  it has a non-empty model AND a base URL. Empty model = fall back to provider. */
export function judgeRoute(provider: ProviderConfig, arbitrator?: ArbitratorConfig): {
  baseUrl: string
  apiKey: string
  model: string
} {
  if (arbitrator?.enabled && arbitrator.model.trim() && arbitrator.baseUrl.trim()) {
    return {
      baseUrl: arbitrator.baseUrl.trim(),
      apiKey: arbitrator.apiKey,
      model: arbitrator.model.trim(),
    }
  }
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.judgeModel,
  }
}

export async function runJudge(args: JudgeArgs, onLog?: (m: string, level: 'info' | 'warn') => void): Promise<JudgeResult> {
  const t0 = Date.now()
  const userMsg = [
    'TASK:',
    args.taskDescription,
    '',
    'RUBRIC:',
    args.rubric,
    '',
    'INPUT:',
    args.input,
    '',
    'RESPONSE A:',
    args.outputA,
    '',
    'RESPONSE B:',
    args.outputB,
    args.expectedOutput ? '\nREFERENCE OUTPUT:\n' + args.expectedOutput : '',
  ].join('\n')

  const route = judgeRoute(args.provider, args.arbitrator)
  const resp = await chatCompletionWithRetry({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    messages: [
      { role: 'system', content: judgeSystemPrompt },
      { role: 'user', content: userMsg },
    ],
    temperature: args.temperature,
    maxTokens: 800,
    timeoutMs: args.provider.requestTimeoutMs,
  }, args.provider.maxRetries)

  const parsed = tryParseJson<Record<string, unknown>>(resp.text)
  if (!parsed || typeof parsed.scoreA !== 'number' || typeof parsed.scoreB !== 'number') {
    onLog?.('judge_parse_failed', 'warn')
    return {
      verdict: {
        winner: 'tie',
        scoreA: 5,
        scoreB: 5,
        reasoning: 'judge_parse_failed',
        feedbackA: '',
        feedbackB: '',
      },
      tokensIn: resp.usage.promptTokens,
      tokensOut: resp.usage.completionTokens,
      latencyMs: Date.now() - t0,
    }
  }

  return {
    verdict: {
      winner: coerceWinner(parsed.winner),
      scoreA: clampScore(parsed.scoreA),
      scoreB: clampScore(parsed.scoreB),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      feedbackA: typeof parsed.feedbackA === 'string' ? parsed.feedbackA : '',
      feedbackB: typeof parsed.feedbackB === 'string' ? parsed.feedbackB : '',
    },
    tokensIn: resp.usage.promptTokens,
    tokensOut: resp.usage.completionTokens,
    latencyMs: Date.now() - t0,
  }
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(10, n))
}
