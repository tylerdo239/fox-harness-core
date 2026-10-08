// User manual served at /docs/ by the web image's nginx (app/Dockerfile, app/nginx.conf.template).
// Static output only: no server, search is Pagefind's offline index.
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  base: '/docs',
  trailingSlash: 'always',
  telemetry: false,
  integrations: [
    starlight({
      title: 'Fox Harness — Hướng dẫn',
      defaultLocale: 'root',
      locales: { root: { label: 'Tiếng Việt', lang: 'vi' } },
      sidebar: [
        { label: 'Bắt đầu', items: [{ autogenerate: { directory: 'bat-dau' } }] },
        { label: 'Chat', items: [{ autogenerate: { directory: 'chat' } }] },
        { label: 'Data Studio', items: [{ autogenerate: { directory: 'data-studio' } }] },
        { label: 'Quản trị', items: [{ autogenerate: { directory: 'quan-tri' } }] },
        { label: 'Khác', items: [{ autogenerate: { directory: 'khac' } }] },
      ],
    }),
  ],
})
