// CI-only static production-build server. It binds loopback, has no credentials,
// and blocks external connections from documents and workers via CSP.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const root = resolve(process.env.E2E_DIST_DIR || 'dist')
const port = Number(process.env.E2E_PORT || 4173)
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
await readFile(resolve(root, 'index.html'))

createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:")
  response.setHeader('Cache-Control', 'no-store')
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname)
    if (pathname.startsWith('/__synthetic/') && request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json')
      // Controlled local provider fixtures. These never proxy requests.
      if (pathname === '/__synthetic/fail/chat/completions') {
        response.writeHead(400).end(JSON.stringify({ error: { message: 'Synthetic provider failure' } }))
      } else if (pathname === '/__synthetic/slow/chat/completions') {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ name: 'Synthetic analysis', description: 'Slow cancellation fixture', rubric: 'Score accuracy from 0 to 10.', examples: [{ input: '1 + 1', expectedOutput: '2' }, { input: '2 + 1', expectedOutput: '3' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }))
      } else response.writeHead(404).end('{}')
      return
    }
    if (pathname === '/__fixture.html') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><html lang="en"><title>Synthetic fixture setup</title></html>')
      return
    }
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end()
      return
    }
    response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream')
    response.end(await readFile(file))
  } catch {
    response.writeHead(404).end('Not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://127.0.0.1:${port}`))
