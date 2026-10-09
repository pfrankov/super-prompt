import { writable } from 'svelte/store'

export interface AppliedRevision { before: string; after: string }
const key = (taskId: string) => `sp.applied-revision.${taskId}`

export interface PendingRevisionLease {
  done: Promise<void>
  release(): void
}

const pendingByTask = new Map<string, PendingRevisionLease>()
const pendingIds = writable<ReadonlySet<string>>(new Set())
export const pendingRevisionTaskIds = { subscribe: pendingIds.subscribe }

/** Keep one Apply/Undo owner per task across same-tab workspace remounts. */
export function beginPendingRevision(taskId: string): PendingRevisionLease | null {
  if (pendingByTask.has(taskId)) return null
  let resolve!: () => void
  const done = new Promise<void>((finished) => { resolve = finished })
  let released = false
  const lease: PendingRevisionLease = {
    done,
    release() {
      if (released) return
      released = true
      if (pendingByTask.get(taskId) === lease) {
        pendingByTask.delete(taskId)
        pendingIds.update((current) => {
          const next = new Set(current)
          next.delete(taskId)
          return next
        })
      }
      resolve()
    },
  }
  pendingByTask.set(taskId, lease)
  pendingIds.update((current) => new Set(current).add(taskId))
  return lease
}

export function pendingRevision(taskId: string): Promise<void> | null {
  return pendingByTask.get(taskId)?.done ?? null
}

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
