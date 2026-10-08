#!/usr/bin/env node
// Screenshots for the user manual (src/assets/screens/*.png), taken from a running Fox Harness with a real model.
// The manual is for role `user`, so shoot as one: a demo account with no real data in it, created by an admin
// (Cài đặt → Người dùng), e.g. demo-user@fox-harness.local; an admin sees screens a user never does.
//
//   DOCS_EMAIL=demo-user@fox-harness.local DOCS_PASSWORD='<password>' pnpm screenshots [name...]
//   DOCS_LOCALE=en DOCS_EMAIL=demo-user-en@fox-harness.local ... pnpm screenshots   # English UI → screens/en/
//
// Use one demo account per language: its chat list shows up in the shots.
//
// Env: DOCS_BASE_URL (default http://127.0.0.1:8080), CHROMIUM_PATH (a Chromium already on the machine; otherwise
// `pnpm exec playwright install chromium` once). It creates chats, a project, a skill and a dashboard in that account.
// Data Studio shots need Dremio and a table an admin opened to role user ("Cho phép role user"). Emails other than the demo account's are masked.

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = process.env.DOCS_BASE_URL ?? 'http://127.0.0.1:8080'
const EMAIL = process.env.DOCS_EMAIL
const PASSWORD = process.env.DOCS_PASSWORD
if (!EMAIL || !PASSWORD) throw new Error('set DOCS_EMAIL and DOCS_PASSWORD (a demo account)')
const LOCALE = process.env.DOCS_LOCALE === 'en' ? 'en' : 'vi'
const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/assets/screens', LOCALE === 'en' ? 'en' : '')

// The app's own labels (app/src/i18n/translations.ts, DataStudioProgress.tsx) and the demo content, per language.
const T = {
  vi: {
    login: 'Đăng nhập', composer: 'Nhắn cho agent…', projectComposer: /Đoạn chat mới trong/, stop: 'Dừng',
    settings: 'Cài đặt', skills: 'Kỹ năng', newSkill: 'Tạo skill mới', skillNamePlaceholder: 'vd. bao-cao-tuan',
    dataAnalysis: 'Phân tích dữ liệu', projects: 'Dự án', create: 'Tạo', newProject: 'Tên dự án mới', createProject: 'Tạo dự án',
    sourcesTab: /^Nguồn/, files: /^Tệp \(/, options: 'Tuỳ chọn', addToDashboard: 'Thêm vào dashboard', added: /Đã thêm biểu đồ/,
    dashboards: 'Bảng điều khiển', edit: 'Chỉnh sửa', progressStep: /Chọn chỉ số đo|Tìm dữ liệu|Kiểm tra độ rõ/,
    maskedEmail: 'nguoi.dung@congty.vn',
    chatQuestion: 'Giải thích ngắn gọn churn rate là gì, kèm một ví dụ tính đơn giản.', chatRow: /churn rate/i,
    skill: ['bao-cao-tuan', 'Dùng khi cần viết báo cáo tuần của phòng theo mẫu chuẩn.', '# Báo cáo tuần\n\n1. Tóm tắt kết quả chính trong 3 gạch đầu dòng.\n2. Số liệu so với tuần trước.\n3. Rủi ro và việc cần hỗ trợ.'],
    project: 'Doanh thu 2026 (demo)', csv: 'doanh_thu_2026.csv', csvHeader: 'thang,khu_vuc,doanh_thu_trieu', regions: ['Bắc', 'Trung', 'Nam'],
    projectQuestion: 'Tóm tắt file doanh_thu_2026.csv và vẽ biểu đồ doanh thu theo tháng cho từng khu vực.',
    dsQuestion: 'Số lượng workflow theo trạng thái?', dashboard: 'Báo cáo vận hành (demo)',
  },
  en: {
    login: 'Log in', composer: 'Message the agent…', projectComposer: /New chat in/, stop: 'Stop',
    settings: 'Settings', skills: 'Skills', newSkill: 'New skill', skillNamePlaceholder: 'e.g. weekly-report',
    dataAnalysis: 'Data analysis', projects: 'Projects', create: 'Create', newProject: 'New project name', createProject: 'Create project',
    sourcesTab: /^Sources/, files: /^Files \(/, options: 'Options', addToDashboard: 'Add to dashboard', added: /Added the chart/,
    dashboards: 'Dashboards', edit: 'Edit', progressStep: /Choosing what to measure|Finding the data|Checking clarity/,
    maskedEmail: 'user@company.com',
    chatQuestion: 'Briefly explain what churn rate is, with a simple worked example.', chatRow: /churn/i,
    skill: ['weekly-report', 'Use when writing the team\'s weekly report in the standard format.', '# Weekly report\n\n1. Summarise the main results in 3 bullets.\n2. Numbers compared with last week.\n3. Risks and help needed.'],
    project: 'Revenue 2026 (demo)', csv: 'revenue_2026.csv', csvHeader: 'month,region,revenue_k_usd', regions: ['North', 'Central', 'South'],
    projectQuestion: 'Summarise revenue_2026.csv and chart monthly revenue for each region.',
    dsQuestion: 'How many workflows are there by status?', dashboard: 'Operations report (demo)',
  },
}[LOCALE]
mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
const LONG = 11 * 60_000 // a real model, tools and Dremio: a turn can take minutes (analyze_data stops at 10)

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: LOCALE === 'en' ? 'en-US' : 'vi-VN' })
await context.addInitScript((locale) => {
  localStorage.setItem('fox-harness/theme', 'light')
  localStorage.setItem('fox-harness/locale', locale)
}, LOCALE)
// Other people's emails never end up in the manual: masked in every text node, as soon as it is rendered.
await context.addInitScript(([me, masked]) => {
  const re = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
  const mask = (node) => {
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const v = n.nodeValue.replace(re, (m) => (m === me ? m : masked))
      if (v !== n.nodeValue) n.nodeValue = v
    }
  }
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') mask(r.target.parentNode ?? r.target)
      for (const n of r.addedNodes) mask(n.nodeType === Node.TEXT_NODE ? n.parentNode ?? n : n)
    }
  }).observe(document, { subtree: true, childList: true, characterData: true })
}, [EMAIL, T.maskedEmail])
const page = await context.newPage()

async function shot(name, { clip, locator } = {}) {
  await page.mouse.move(1279, 799) // no hover highlight left on the last thing clicked
  await page.waitForTimeout(600) // lists load, animations settle
  const path = join(OUT, `${name}.png`)
  if (locator) await locator.screenshot({ path })
  else await page.screenshot({ path, clip })
  console.log(`[shot] ${name}`)
}

/** Waits until the agent's reply has finished: the Stop button is gone again. */
async function turnDone() {
  await page.getByRole('button', { name: T.stop }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  await page.getByRole('button', { name: T.stop }).waitFor({ state: 'detached', timeout: LONG })
  await page.waitForTimeout(1500)
}

async function send(text) {
  const box = page.getByPlaceholder(T.composer).or(page.getByPlaceholder(T.projectComposer))
  await box.fill(text)
  await box.press('Enter')
}

const steps = {
  async login() {
    await page.goto(BASE)
    await page.getByRole('button', { name: T.login }).waitFor()
    await shot('login')
    await page.locator('input[type=email]').fill(EMAIL)
    await page.locator('input[type=password]').fill(PASSWORD)
    await page.getByRole('button', { name: T.login }).click()
    await page.getByPlaceholder(T.composer).waitFor()
    await shot('home')
  },

  async chat() {
    await page.goto(BASE)
    await page.getByPlaceholder(T.composer).waitFor()
    await send(T.chatQuestion)
    await turnDone()
    await shot('chat')
    await page.getByText(T.chatRow).first().hover().catch(() => {})
    await page.getByTitle(T.options).first().click()
    await shot('chat-row-menu', { clip: { x: 0, y: 0, width: 640, height: 600 } })
    await page.keyboard.press('Escape')
  },

  async settings() {
    await page.goto(BASE)
    await page.locator('#account-menu-trigger').click()
    await shot('account-menu', { clip: { x: 0, y: 400, width: 640, height: 400 } })
    await page.getByText(T.settings, { exact: true }).first().click()
    await page.getByRole('dialog').waitFor()
    await shot('settings')
    await page.keyboard.press('Escape')
  },

  async skills() {
    await page.goto(BASE)
    await page.getByText(T.skills, { exact: true }).first().click()
    await page.getByRole('dialog').waitFor()
    await shot('skills')
    await page.getByText(T.newSkill).click()
    await page.getByPlaceholder(T.skillNamePlaceholder).fill(T.skill[0])
    const fields = page.getByRole('dialog').locator(`textarea, input:not([placeholder="${T.skillNamePlaceholder}"])`)
    await fields.nth(0).fill(T.skill[1])
    await fields.nth(1).fill(T.skill[2])
    await shot('skill-form')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.goto(BASE)
    await page.getByPlaceholder(T.composer).fill('/')
    await page.getByText('/web-research').waitFor()
    await shot('skill-menu')
  },

  async projects() {
    await page.goto(BASE)
    await page.getByText(T.dataAnalysis, { exact: true }).first().click()
    const name = T.project
    await page.getByRole('heading', { name: T.projects }).waitFor()
    if (!(await page.getByText(name).count())) {
      await page.getByRole('button', { name: T.create, exact: true }).click()
      await page.getByPlaceholder(T.newProject).fill(name)
      await page.getByRole('button', { name: T.createProject }).click()
      await page.getByPlaceholder(T.projectComposer).waitFor()
      await page.goBack()
    }
    await shot('projects')
    await page.getByText(name).first().click()
    await page.getByPlaceholder(T.projectComposer).waitFor()
    await page.getByRole('tab', { name: T.sourcesTab }).or(page.getByText(T.sourcesTab)).first().click()
    const csv = join(tmpdir(), T.csv)
    const rows = [T.csvHeader]
    for (let m = 1; m <= 9; m++) for (const [k, base] of [[T.regions[0], 820], [T.regions[1], 410], [T.regions[2], 960]]) rows.push(`2026-${String(m).padStart(2, '0')},${k},${base + m * 37 + (m % 3) * 55}`)
    writeFileSync(csv, rows.join('\n'))
    if (!(await page.getByText(T.csv).count())) {
      await page.locator('input[type=file]').first().setInputFiles(csv)
      await page.getByText(T.csv).first().waitFor({ timeout: 60_000 })
    }
    await shot('project-sources')
    await send(T.projectQuestion)
    await page.getByPlaceholder(T.composer).waitFor()
    await turnDone()
    await shot('project-chat')
    await page.getByRole('button', { name: T.files }).click()
    await shot('project-files')
  },

  async dataStudio() {
    // one demo dashboard, not one more per run
    const token = (await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()).token
    const auth = { authorization: `Bearer ${token}` }
    for (const d of await (await fetch(`${BASE}/data-studio/dashboards`, { headers: auth })).json()) {
      if (d.title === T.dashboard) await fetch(`${BASE}/data-studio/dashboards/${d.id}`, { method: 'DELETE', headers: auth })
    }
    await page.goto(BASE)
    await page.getByText('Data Studio', { exact: true }).first().click()
    await page.getByPlaceholder(T.composer).waitFor()
    await shot('ds-home')
    await send(process.env.DOCS_DS_QUESTION ?? T.dsQuestion)
    // the live steps, once a few are done
    await page.locator('.ds-progress, [class*=progress]').getByText(T.progressStep).first().waitFor({ timeout: LONG }).catch(() => {})
    await page.waitForTimeout(3000)
    if (await page.getByRole('button', { name: T.stop }).count()) await shot('ds-progress')
    await turnDone()
    await page.locator('.recharts-wrapper, table').first().evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await shot('ds-answer')
    await page.getByRole('button', { name: T.addToDashboard }).first().click()
    await page.getByRole('dialog').waitFor()
    await shot('ds-pin')
    const dialog = page.getByRole('dialog')
    await dialog.locator('input').last().fill(T.dashboard)
    await dialog.getByRole('button', { name: T.create, exact: true }).click()
    await dialog.getByText(T.added).waitFor()
    await page.keyboard.press('Escape')
    await page.getByText(T.dashboards, { exact: true }).first().click()
    await shot('dashboards')
    await page.getByText(T.dashboard).first().click()
    await shot('dashboard-view')
    await page.getByRole('button', { name: T.edit }).click()
    await shot('dashboard-builder')
  },

}

for (const [name, step] of Object.entries(steps)) {
  if (only.length && !only.includes(name) && name !== 'login') continue
  try {
    await step()
  } catch (error) {
    console.log(`[shot] ${name} FAILED: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
    await page.screenshot({ path: join(tmpdir(), `docs-shot-${name}-failed.png`) })
  }
}
await browser.close()
