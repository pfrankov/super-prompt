import type { ArbitratorConfig, DatasetItem, ProviderConfig, Task } from '../types'
import { chatCompletion } from '../api/openaiLike'
import { tryParseJson } from '../optimizer/extract-json'
import { judgeSystemPrompt } from '../optimizer/prompts/judgeSystem'
import { mutatorSystemPrompt } from '../optimizer/prompts/mutatorSystem'
import { judgeRoute } from '../optimizer/judge'
import { isRunnableProvider } from './model-routing'

export type PreflightKey = 'provider' | 'target' | 'judgeJson' | 'mutatorJson'
export type PreflightStatus = 'ok' | 'warn' | 'fail'

export interface PreflightStep {
  key: PreflightKey
  status: PreflightStatus
  message: string
  action: string
}

export interface PreflightResult {
  ready: boolean
  steps: PreflightStep[]
}

export interface RunPreflightArgs {
  provider: ProviderConfig
  arbitrator?: ArbitratorConfig
  task: Task
  items: DatasetItem[]
  signal?: AbortSignal
}

function ok(key: PreflightKey, message: string): PreflightStep {
  return { key, status: 'ok', message, action: '' }
}

function warn(key: PreflightKey, message: string, action: string): PreflightStep {
  return { key, status: 'warn', message, action }
}

function fail(key: PreflightKey, message: string, action: string): PreflightStep {
  return { key, status: 'fail', message, action }
}

export function preflightReady(steps: PreflightStep[]): boolean {
  return steps.every((step) => step.status !== 'fail')
}

export function nextPreflightAction(steps: PreflightStep[]): string {
  const failed = steps.find((step) => step.status === 'fail')
  if (failed) return /rate[- ]limited/i.test(failed.message) ? failed.message : failed.action
  return steps.find((step) => step.status === 'warn')?.action ?? ''
}

function firstItem(items: DatasetItem[]): DatasetItem {
  return items[0] ?? {
    id: 'synthetic',
    datasetId: 'synthetic',
    input: 'Say hello in one short sentence.',
    expectedOutput: 'Hello.',
  }
}

function parseJudgeJson(text: string): boolean {
  const parsed = tryParseJson<Record<string, unknown>>(text)
  return !!parsed && typeof parsed.scoreA === 'number' && typeof parsed.scoreB === 'number'
}

function parseMutatorJson(text: string): boolean {
  const parsed = tryParseJson<Record<string, unknown>>(text)
  return !!parsed && typeof parsed.newPrompt === 'string' && parsed.newPrompt.trim().length > 0
}

export async function runPreflight(args: RunPreflightArgs): Promise<PreflightResult> {
  const steps: PreflightStep[] = []

  if (!isRunnableProvider(args.provider)) {
    steps.push(fail('provider', 'Provider needs an API key or a local endpoint.', 'Add an API key or switch to local Ollama.'))
    return { ready: false, steps }
  }
  steps.push(ok('provider', 'Provider configuration is usable for a direct chat request.'))

  const item = firstItem(args.items)
  try {
    const target = await chatCompletion({
      baseUrl: args.provider.baseUrl,
      apiKey: args.provider.apiKey,
      model: args.provider.targetModel,
      messages: [
        { role: 'system', content: args.task.initialPrompt },
        { role: 'user', content: item.input },
      ],
      temperature: 0,
      maxTokens: 200,
      timeoutMs: args.provider.requestTimeoutMs,
      signal: args.signal,
      rateLimits: args.provider.modelRateLimits,
    })
    if (target.text.trim()) {
      steps.push(ok('target', 'Target model returned a non-empty answer.'))
    } else {
      steps.push(fail('target', 'Target model returned empty content.', 'Choose another target model or increase the model output limit.'))
    }
  } catch (e) {
    steps.push(fail('target', e instanceof Error ? e.message : 'Target model failed.', 'Choose a reachable target model.'))
  }

  const route = judgeRoute(args.provider, args.arbitrator)
  try {
    const judge = await chatCompletion({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      messages: [
        { role: 'system', content: judgeSystemPrompt },
        {
          role: 'user',
          content: [
            'TASK:',
            args.task.description || 'Evaluate answer quality.',
            '',
            'RUBRIC:',
            args.task.rubric.text || 'Follow the system prompt and answer the user correctly.',
            '',
            'INPUT:',
            item.input,
            '',
            'RESPONSE A:',
            item.expectedOutput || 'Correct concise answer.',
            '',
            'RESPONSE B:',
            'Incorrect or verbose answer.',
          ].join('\n'),
        },
      ],
      temperature: 0,
      maxTokens: 800,
      timeoutMs: args.provider.requestTimeoutMs,
      signal: args.signal,
      rateLimits: args.provider.modelRateLimits,
    })
    if (parseJudgeJson(judge.text)) {
      steps.push(ok('judgeJson', 'Judge returns parseable JSON.'))
    } else {
      steps.push(fail('judgeJson', 'Judge did not return parseable scores.', 'Use a JSON-stable judge model.'))
    }
  } catch (e) {
    steps.push(fail('judgeJson', e instanceof Error ? e.message : 'Judge check failed.', 'Use a reachable judge model.'))
  }

  try {
    const mutator = await chatCompletion({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      messages: [
        { role: 'system', content: mutatorSystemPrompt },
        {
          role: 'user',
          content: [
            'TASK:',
            args.task.description || 'Improve the prompt.',
            '',
            'RUBRIC:',
            args.task.rubric.text || 'Follow the user request accurately and concisely.',
            '',
            'CURRENT PROMPT (parent):',
            args.task.initialPrompt,
            '',
            'PARENT SCORE: 5.00',
            'CHALLENGER SCORE: n/a',
            '',
            'AGGREGATED FEEDBACK FROM JUDGES:',
            'Make the instruction clearer while preserving intent.',
          ].join('\n'),
        },
      ],
      temperature: 0,
      maxTokens: 1000,
      timeoutMs: args.provider.requestTimeoutMs,
      signal: args.signal,
      rateLimits: args.provider.modelRateLimits,
    })
    if (parseMutatorJson(mutator.text)) {
      steps.push(ok('mutatorJson', 'Mutator returns parseable JSON.'))
    } else {
      steps.push(fail('mutatorJson', 'Mutator did not return a newPrompt JSON field.', 'Use the same JSON-stable model for judge and mutator.'))
    }
  } catch (e) {
    steps.push(fail('mutatorJson', e instanceof Error ? e.message : 'Mutator check failed.', 'Use a reachable mutator model.'))
  }

  return {
    ready: preflightReady(steps),
    steps,
  }
}
