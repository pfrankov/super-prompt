import { writable } from 'svelte/store'
import { newId } from '../lib/util/id'

export interface Toast {
  id: string
  level: 'info' | 'success' | 'warn' | 'error'
  msg: string
  ttl: number
}

export const toasts = writable<Toast[]>([])

export function toast(level: Toast['level'], msg: string, ttl = 4000): void {
  const id = newId(8)
  toasts.update((arr) => [...arr, { id, level, msg, ttl }])
  setTimeout(() => {
    toasts.update((arr) => arr.filter((t) => t.id !== id))
  }, ttl)
}

export const t = {
  info: (m: string) => toast('info', m),
  success: (m: string) => toast('success', m),
  warn: (m: string) => toast('warn', m),
  error: (m: string) => toast('error', m, 6000),
}