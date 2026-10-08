// User manual served at /docs/ by the web image's nginx (app/Dockerfile, app/nginx.conf.template).
// Static output only: no server, search is Pagefind's offline index. Vietnamese at /docs/, English at /docs/en/
// (same page paths, so the language switch lands on the same page).
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  base: '/docs',
  trailingSlash: 'always',
  telemetry: false,
  integrations: [
    starlight({
      title: { vi: 'Fox Harness — Hướng dẫn', en: 'Fox Harness — User guide' },
      defaultLocale: 'root',
      locales: {
        root: { label: 'Tiếng Việt', lang: 'vi' },
        en: { label: 'English', lang: 'en' },
      },
      customCss: ['./src/styles/theme.css'],
      sidebar: [
        { label: 'Bắt đầu', translations: { en: 'Getting started' }, items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Chat', translations: { en: 'Chat' }, items: [{ autogenerate: { directory: 'chat' } }] },
        { label: 'Data Studio', translations: { en: 'Data Studio' }, items: [{ autogenerate: { directory: 'data-studio' } }] },
        { label: 'Khác', translations: { en: 'More' }, items: [{ autogenerate: { directory: 'more' } }] },
      ],
    }),
  ],
})
