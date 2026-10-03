export interface AppliedRevision { before: string; after: string }
const key = (taskId: string) => `sp.applied-revision.${taskId}`

// One undo per prompt, scoped to this browser tab. Never restore over later edits.
export function readAppliedRevision(taskId: string, current: string): AppliedRevision | null {
  try {
    const record = JSON.parse(sessionStorage.getItem(key(taskId)) ?? 'null')
    return record && typeof record.before === 'string' && typeof record.after === 'string'
      && record.after === current ? record : null
  } catch { return null }
}

export function storeAppliedRevision(taskId: string, revision: AppliedRevision | null): void {
  try {
    if (revision) sessionStorage.setItem(key(taskId), JSON.stringify(revision))
    else sessionStorage.removeItem(key(taskId))
  } catch { /* In-memory undo remains available when session storage is full. */ }
}
