#!/usr/bin/env node
// Screenshots for the user manual (src/assets/screens/*.png), taken from a running Fox Harness with a real model.
// Use a demo account with no real data in it (an admin: the Quản trị pages need one), e.g. on the local stack:
//
//   docker exec fox-harness-backend-1 node scripts/create-admin.mjs demo@fox-harness.local '<password>'
//   DOCS_EMAIL=demo@fox-harness.local DOCS_PASSWORD='<password>' pnpm screenshots [name...]
//
// Env: DOCS_BASE_URL (default http://127.0.0.1:8080), CHROMIUM_PATH (a Chromium already on the machine; otherwise
// `pnpm exec playwright install chromium` once). It creates chats, a project, a skill and a dashboard in that account.
// Data Studio shots need Dremio with at least one table enabled. Emails other than the demo account's are masked.

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = process.env.DOCS_BASE_URL ?? 'http://127.0.0.1:8080'
const EMAIL = process.env.DOCS_EMAIL
const PASSWORD = process.env.DOCS_PASSWORD
if (!EMAIL || !PASSWORD) throw new Error('set DOCS_EMAIL and DOCS_PASSWORD (a demo account)')
const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/assets/screens')
mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
const LONG = 11 * 60_000 // a real model, tools and Dremio: a turn can take minutes (analyze_data stops at 10)

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: 'vi-VN' })
await context.addInitScript(() => {
  localStorage.setItem('fox-harness/theme', 'light')
  localStorage.setItem('fox-harness/locale', 'vi')
})
// Other people's emails never end up in the manual: masked in every text node, as soon as it is rendered.
await context.addInitScript((me) => {
  const re = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
  const mask = (node) => {
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const v = n.nodeValue.replace(re, (m) => (m === me ? m : 'nguoi.dung@congty.vn'))
      if (v !== n.nodeValue) n.nodeValue = v
    }
  }
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') mask(r.target.parentNode ?? r.target)
      for (const n of r.addedNodes) mask(n.nodeType === Node.TEXT_NODE ? n.parentNode ?? n : n)
    }
  }).observe(document, { subtree: true, childList: true, characterData: true })
}, EMAIL)
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
  await page.getByRole('button', { name: 'Dừng' }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  await page.getByRole('button', { name: 'Dừng' }).waitFor({ state: 'detached', timeout: LONG })
  await page.waitForTimeout(1500)
}

async function send(text) {
  const box = page.getByPlaceholder(/Nhắn cho agent|Đoạn chat mới trong/)
  await box.fill(text)
  await box.press('Enter')
}

const steps = {
  async login() {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Đăng nhập' }).waitFor()
    await shot('login')
    await page.locator('input[type=email]').fill(EMAIL)
    await page.locator('input[type=password]').fill(PASSWORD)
    await page.getByRole('button', { name: 'Đăng nhập' }).click()
    await page.getByPlaceholder('Nhắn cho agent…').waitFor()
    await shot('home')
  },

  async chat() {
    await page.goto(BASE)
    await page.getByPlaceholder('Nhắn cho agent…').waitFor()
    await send('Giải thích ngắn gọn churn rate là gì, kèm một ví dụ tính đơn giản.')
    await turnDone()
    await shot('chat')
    const row = page.locator('.fh-history-row, [class*=history] li, [class*=history] [role=button]').first()
    await page.getByText(/churn rate/i).first().hover().catch(() => {})
    await page.getByTitle('Tuỳ chọn').first().click()
    await shot('chat-row-menu', { clip: { x: 0, y: 0, width: 640, height: 600 } })
    await page.keyboard.press('Escape')
    void row
  },

  async settings() {
    await page.goto(BASE)
    await page.locator('#account-menu-trigger').click()
    await shot('account-menu', { clip: { x: 0, y: 400, width: 640, height: 400 } })
    await page.getByText('Cài đặt', { exact: true }).first().click()
    await page.getByRole('dialog').waitFor()
    await shot('settings')
    await page.getByRole('dialog').getByText('Người dùng', { exact: true }).click()
    await shot('settings-users')
    await page.keyboard.press('Escape')
  },

  async skills() {
    await page.goto(BASE)
    await page.getByText('Kỹ năng', { exact: true }).first().click()
    await page.getByRole('dialog').waitFor()
    await shot('skills')
    await page.getByText('Tạo skill mới').click()
    await page.getByPlaceholder('vd. bao-cao-tuan').fill('bao-cao-tuan')
    const fields = page.getByRole('dialog').locator('textarea, input:not([placeholder="vd. bao-cao-tuan"])')
    await fields.nth(0).fill('Dùng khi cần viết báo cáo tuần của phòng theo mẫu chuẩn.')
    await fields.nth(1).fill('# Báo cáo tuần\n\n1. Tóm tắt kết quả chính trong 3 gạch đầu dòng.\n2. Số liệu so với tuần trước.\n3. Rủi ro và việc cần hỗ trợ.')
    await shot('skill-form')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.goto(BASE)
    await page.getByPlaceholder('Nhắn cho agent…').fill('/')
    await page.getByText('/web-research').waitFor()
    await shot('skill-menu')
  },

  async projects() {
    await page.goto(BASE)
    await page.getByText('Phân tích dữ liệu', { exact: true }).first().click()
    const name = 'Doanh thu 2026 (demo)'
    await page.getByRole('heading', { name: 'Dự án' }).waitFor()
    if (!(await page.getByText(name).count())) {
      await page.getByRole('button', { name: 'Tạo', exact: true }).click()
      await page.getByPlaceholder('Tên dự án mới').fill(name)
      await page.getByRole('button', { name: 'Tạo dự án' }).click()
      await page.getByPlaceholder(/Đoạn chat mới trong/).waitFor()
      await page.goBack()
    }
    await shot('projects')
    await page.getByText(name).first().click()
    await page.getByPlaceholder(/Đoạn chat mới trong/).waitFor()
    await page.getByRole('tab', { name: /Nguồn/ }).or(page.getByText(/^Nguồn/)).first().click()
    const csv = join(tmpdir(), 'doanh_thu_2026.csv')
    const rows = ['thang,khu_vuc,doanh_thu_trieu']
    for (let m = 1; m <= 9; m++) for (const [k, base] of [['Bắc', 820], ['Trung', 410], ['Nam', 960]]) rows.push(`2026-${String(m).padStart(2, '0')},${k},${base + m * 37 + (m % 3) * 55}`)
    writeFileSync(csv, rows.join('\n'))
    if (!(await page.getByText('doanh_thu_2026.csv').count())) {
      await page.locator('input[type=file]').first().setInputFiles(csv)
      await page.getByText('doanh_thu_2026.csv').first().waitFor({ timeout: 60_000 })
    }
    await shot('project-sources')
    await send('Tóm tắt file doanh_thu_2026.csv và vẽ biểu đồ doanh thu theo tháng cho từng khu vực.')
    await page.getByPlaceholder('Nhắn cho agent…').waitFor()
    await turnDone()
    await shot('project-chat')
    await page.getByRole('button', { name: /^Tệp \(/ }).click()
    await shot('project-files')
  },

  async dataStudio() {
    // one demo dashboard, not one more per run
    const token = (await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()).token
    const auth = { authorization: `Bearer ${token}` }
    for (const d of await (await fetch(`${BASE}/data-studio/dashboards`, { headers: auth })).json()) {
      if (d.title === 'Báo cáo vận hành (demo)') await fetch(`${BASE}/data-studio/dashboards/${d.id}`, { method: 'DELETE', headers: auth })
    }
    await page.goto(BASE)
    await page.getByText('Data Studio', { exact: true }).first().click()
    await page.getByPlaceholder('Nhắn cho agent…').waitFor()
    await shot('ds-home')
    await send(process.env.DOCS_DS_QUESTION ?? 'Số workflow được tạo phân theo loại workflow là bao nhiêu?')
    await turnDone()
    await page.locator('.recharts-wrapper, table').first().evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await shot('ds-answer')
    await page.getByRole('button', { name: 'Thêm vào dashboard' }).first().click()
    await page.getByRole('dialog').waitFor()
    await shot('ds-pin')
    const dialog = page.getByRole('dialog')
    await dialog.locator('input').last().fill('Báo cáo vận hành (demo)')
    await dialog.getByRole('button', { name: 'Tạo', exact: true }).click()
    await dialog.getByText(/Đã thêm biểu đồ/).waitFor()
    await page.keyboard.press('Escape')
    await page.getByText('Bảng điều khiển', { exact: true }).first().click()
    await shot('dashboards')
    await page.getByText('Báo cáo vận hành (demo)').first().click()
    await shot('dashboard-view')
    await page.getByRole('button', { name: 'Chỉnh sửa' }).click()
    await shot('dashboard-builder')
  },

  async adminSources() {
    await page.goto(BASE)
    await page.getByText('Data Studio', { exact: true }).first().click()
    await page.getByText('Nguồn dữ liệu', { exact: true }).first().click()
    await shot('ds-sources')
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
