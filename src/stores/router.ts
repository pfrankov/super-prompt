import { writable } from 'svelte/store'

export type Route =
  | { name: 'home' }
  | { name: 'task'; id: string; tab?: string }
  | { name: 'settings' }
  | { name: 'notfound'; path: string }

function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '').replace(/^\//, '') || ''
  if (h === '' || h === '/') return { name: 'home' }
  if (h === 'settings') return { name: 'settings' }
  const taskMatch = h.match(/^task\/([^/]+)(?:\/(\w+))?$/)
  if (taskMatch) return { name: 'task', id: taskMatch[1], tab: taskMatch[2] }
  return { name: 'notfound', path: h }
}

const initial: Route = typeof window !== 'undefined' ? parseHash(window.location.hash) : { name: 'home' }

export const route = writable<Route>(initial)

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.set(parseHash(window.location.hash))
  })
}

export function navigate(hash: string): void {
  const target = hash.startsWith('#') ? hash : '#' + hash
  if (window.location.hash === target) {
    route.set(parseHash(target))
  } else {
    window.location.hash = target
  }
}
