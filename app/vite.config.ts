/// <reference types="vitest/config" />
// Build and dev server for the web UI (docs/ui-performance-plan.md, phase 1 — replaces scripts/build.mjs and
// scripts/serve.mjs). `vite build` writes dist/ (what the nginx image serves); `vite` is the dev server with HMR.
//
// What stays exactly as before, so the page looks the same:
// - the stylesheets: public/theme.css, sonner.css, style.css, ref.css, tw.css, linked from index.html in the same
//   order, copied byte for byte (Vite does not touch public/). ref.css and tw.css are still the two scoped Tailwind
//   builds (tailwind.ref.config.cjs, tailwind.canvas.config.cjs), made by the plugin below.
// - the API paths the dev server forwards: read from nginx.conf.template, like serve.mjs did.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const appRoot = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// The two scoped Tailwind stylesheets and sonner's own CSS, written into public/ (served and copied as-is).
const TAILWIND_BUILDS = [
  { input: 'src/ref/ref.css', config: 'tailwind.ref.config.cjs', output: 'public/ref.css' },
  { input: 'src/tw/tw.css', config: 'tailwind.canvas.config.cjs', output: 'public/tw.css' },
]

async function buildStaticCss(): Promise<boolean> {
  const postcss = require('postcss')
  const tailwind = require('tailwindcss')
  let changed = false
  for (const item of TAILWIND_BUILDS) {
    const from = join(appRoot, item.input)
    const to = join(appRoot, item.output)
    // tailwindcss caches its config by path; drop it so a dev edit of a config is picked up
    delete require.cache[require.resolve(join(appRoot, item.config))]
    const result = await postcss([tailwind(join(appRoot, item.config))]).process(readFileSync(from, 'utf8'), { from, to })
    if (!existsSync(to) || readFileSync(to, 'utf8') !== result.css) {
      writeFileSync(to, result.css)
      changed = true
    }
  }
  copyFileSync(join(appRoot, 'node_modules/sonner/dist/styles.css'), join(appRoot, 'public/sonner.css'))
  return changed
}

function staticCss(): Plugin {
  return {
    name: 'fh-static-css',
    async buildStart() {
      await buildStaticCss()
    },
    // dev: a new Tailwind class in a component regenerates the stylesheet; reload only when its output changed
    configureServer(server) {
      let timer: NodeJS.Timeout | undefined
      const onChange = (file: string) => {
        const rel = relative(appRoot, file)
        if (!rel.startsWith('src/') && !rel.startsWith('tailwind.')) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          buildStaticCss()
            .then((changed) => changed && server.ws.send({ type: 'full-reload' }))
            .catch((error) => server.config.logger.error(`[fh-static-css] ${error}`))
        }, 150)
      }
      server.watcher.on('change', onChange)
      server.watcher.on('add', onChange)
    },
  }
}

// The backend paths, from nginx.conf.template, so the dev server and the web container never disagree.
const nginxConf = readFileSync(join(appRoot, 'nginx.conf.template'), 'utf8')
const API_PATH = /location ~ (\^\/\([^)]*\)\(\/\|\$\))/.exec(nginxConf)![1]
// Browser routes under an API prefix (the Data Studio pages, the usage page): every location that serves /index.html.
const SPA_PATHS = [...nginxConf.matchAll(/location ~ (\S+) \{\s*try_files \/index\.html/g)].map((m) => new RegExp(m[1]))

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, appRoot, '')
  const backend = env.BACKEND_URL
  if (command === 'serve' && !backend && !process.env.VITEST) {
    throw new Error('BACKEND_URL is not set — put it in app/.env (see app/.env.example), e.g. BACKEND_URL=http://127.0.0.1:4000')
  }
  return {
    root: appRoot,
    plugins: [react(), staticCss()],
    resolve: {
      // the copied reference screens (src/ref/) import `@/...` and `next/link` (tsconfig.json paths)
      alias: [
        { find: /^@\//, replacement: `${join(appRoot, 'src/ref')}/` },
        { find: /^next\/link$/, replacement: join(appRoot, 'src/ref/shims/link.tsx') },
      ],
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      // the canvas libraries (ExcelJS, CodeMirror, docx-preview) are big on purpose and load only with the canvas
      chunkSizeWarningLimit: 2000,
    },
    server: {
      port: Number(env.PORT ?? 5173),
      proxy: backend
        ? {
            [API_PATH]: {
              target: backend,
              changeOrigin: true,
              ws: true,
              bypass: (req) => {
                const pathname = new URL(req.url ?? '/', 'http://x').pathname
                return SPA_PATHS.some((re) => re.test(pathname)) ? '/index.html' : undefined
              },
            },
          }
        : undefined,
    },
    preview: { port: Number(env.PORT ?? 5173) },
    // pnpm test: unit tests next to the code (*.test.ts[x]); a file that needs the DOM says `@vitest-environment jsdom`
    test: { include: ['src/**/*.test.{ts,tsx}'], exclude: ['src/ref/**'] },
  }
})
