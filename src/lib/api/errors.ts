export class ApiError extends Error {
  status: number
  body: unknown
  retriable: boolean
  retried: number

  constructor(opts: { message?: string; status: number; body?: unknown; retriable?: boolean; cause?: unknown }) {
    super(opts.message ?? `HTTP ${opts.status}`)
    this.name = 'ApiError'
    this.status = opts.status
    this.body = opts.body
    this.retriable = opts.retriable ?? (opts.status === 429 || opts.status >= 500)
    this.retried = 0
    if (opts.cause) (this as Error & { cause?: unknown }).cause = opts.cause
  }
}

export class ParseError extends Error {
  raw: string
  constructor(message: string, raw: string) {
    super(message)
    this.name = 'ParseError'
    this.raw = raw
  }
}