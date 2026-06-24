/** Format a duration in milliseconds as a human-readable ETA. */
export function formatEta(ms: number, lang: 'en' | 'ru' = 'en'): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return lang === 'ru' ? `${sec} с` : `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  if (min < 60) {
    return lang === 'ru' ? `${min} мин ${rem} с` : `${min}m ${rem}s`
  }
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return lang === 'ru' ? `${hr} ч ${remMin} мин` : `${hr}h ${remMin}m`
}

/** Format a timestamp as a localised date+time. */
export function formatDateTime(ts: number, lang: 'en' | 'ru' = 'en'): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return new Date(ts).toISOString()
  }
}

/** Slugify a task name for filenames. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
