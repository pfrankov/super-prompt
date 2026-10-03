// A tiny synchronous journal protects the last prompt edit during page teardown.
// IndexedDB remains the durable source of truth; successful saves clear the journal.
const keyFor = (taskId: string) => `sp.prompt-draft.${taskId}`

export function stagePromptDraft(taskId: string, prompt: string): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(keyFor(taskId), prompt)
}

export function readPromptDraft(taskId: string): string | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(keyFor(taskId)) }
  catch { return null }
}

export function clearPromptDraft(taskId: string, savedPrompt?: string): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    if (savedPrompt === undefined || readPromptDraft(taskId) === savedPrompt) sessionStorage.removeItem(keyFor(taskId))
  } catch { /* An unavailable journal must not turn a completed DB write into a failure. */ }
}
