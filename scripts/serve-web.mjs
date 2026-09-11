// Real fix for a recurring real problem: `python3 -m http.server` (what this
// project's dev workflow had been using ad hoc to serve `apps/web/public/`)
// sends NO `Cache-Control` header at all, so browsers apply their own
// heuristic caching on `main.js`/`style.css` — a normal reload can keep
// showing OLD content even though the server is genuinely serving the NEW
// file (confirmed via `curl` more than once). This project never had an
// official "serve apps/web" script of its own at all; this is that script,
// with the one property that actually matters here: every response is
// `Cache-Control: no-store`, so the browser can never serve a stale copy —
// appropriate for a dev-scope project like this one (docs/code-rules.md's
// "no more than needed" applies to NOT building a production CDN-caching
// story here either).

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../apps/web/public', import.meta.url))
const PORT = Number(process.env.PORT ?? 5173)

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

function sendFile(res, filePath) {
  return stat(filePath).then((stats) => {
    if (!stats.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'content-length': stats.size,
      // The whole reason this script exists — see file header.
      'cache-control': 'no-store',
    })
    createReadStream(filePath).pipe(res)
  })
}

// Real gap fixed 2026-09-10: this file's own header comment promises
// "every response is Cache-Control: no-store" — the 404 branches below
// never actually set it, so a browser was free to apply its own default
// heuristic caching to a 404 (there is no `Cache-Control` at all on those
// responses without this). A route that legitimately 404'd once (a typo'd
// path, or requested before a real file existed yet) could then keep
// LOOKING 404 on a later reload even after the real file/fallback was
// serving fine — the exact class of stale-cache bug this whole script
// exists to prevent, just on the one response shape that had been missed.
function send404(res) {
  res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
  res.end('not found')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const requestedPathname = decodeURIComponent(url.pathname)
  let pathname = requestedPathname
  if (pathname === '/') pathname = '/index.html'
  const filePath = normalize(join(ROOT, pathname))
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403)
    res.end()
    return
  }

  void sendFile(res, filePath).catch(() => {
    // Real client-side-routing fallback (2026-09-09, `/chat/<id>` routing):
    // this project's SPA now has real address-bar routes with no matching
    // file on disk — a direct visit, bookmark, or reload of `/chat/<id>`
    // must still load the app instead of 404ing. Only routes fall back,
    // not missing assets: a route-shaped path has no `.` in its last
    // segment (`/chat/<uuid>`), whereas a real missing asset request
    // (`/does-not-exist.js`) does and still 404s normally below.
    const lastSegment = requestedPathname.split('/').pop() ?? ''
    if (requestedPathname !== '/index.html' && !lastSegment.includes('.')) {
      void sendFile(res, join(ROOT, 'index.html')).catch(() => {
        send404(res)
      })
      return
    }
    send404(res)
  })
})

server.listen(PORT, () => {
  console.log(`[serve-web] http://127.0.0.1:${PORT} -> ${ROOT} (Cache-Control: no-store on every response)`)
})
