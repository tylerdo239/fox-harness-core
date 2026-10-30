#!/usr/bin/env node
// UI parity check (docs/ui-performance-plan.md §3): the same pages on two running builds of the app — the current
// one (OLD_URL) and the changed one (NEW_URL), both on the same backend and the same account — are screenshotted
// and compared pixel by pixel, and their #root DOM compared as text. Every step of the plan must end at 0 pixels
// different, so a refactor or a build change can't move anything on screen unnoticed.
//
//   OLD_URL=http://localhost:18081 NEW_URL=http://localhost:8080 \
//   PARITY_EMAIL=... PARITY_PASSWORD=... node scripts/ui-parity.mjs
//
// Uses the installed Google Chrome (playwright-core, channel "chrome"); no browser download. Shots and diffs of
// any page that differs go to app/.parity/ (git-ignored). Exit code 1 when anything differs.
// A chat with some history on the account makes the run cover the chat view and the delete confirm dialog too.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pixelmatch from 'pixelmatch'
import { chromium } from 'playwright-core'
import { PNG } from 'pngjs'

const { OLD_URL, NEW_URL, PARITY_EMAIL, PARITY_PASSWORD } = process.env
if (!OLD_URL || !NEW_URL || !PARITY_EMAIL || !PARITY_PASSWORD) {
  console.error('set OLD_URL, NEW_URL, PARITY_EMAIL and PARITY_PASSWORD (see the header of this file)')
  process.exit(2)
}
// PARITY_IGNORE_CLASS=1: compare the DOM without class attributes — for a change that moves styles into classes
// (the pixels must still match exactly; scripts/ui-styles.mjs compares the computed styles)
const IGNORE_CLASS = process.env.PARITY_IGNORE_CLASS === '1'
const OUT = fileURLToPath(new URL('../.parity/', import.meta.url))
mkdirSync(OUT, { recursive: true })
// only this script's own output: .parity/styles/ belongs to ui-styles.mjs
for (const name of readdirSync(OUT)) if (/\.(png|html)$/.test(name)) rmSync(join(OUT, name))

const PAGES = ['/data', '/data-studio', '/my-skills', '/admin/usage']
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }

const settle = (page, ms = 2500) => page.waitForLoadState('networkidle').catch(() => {}).then(() => page.waitForTimeout(ms))

async function shoot(page, name) {
  await page.mouse.move(0, 0)
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  // #root as text with each element's attributes sorted: attribute order means nothing to the page, and React
  // versions write them in different orders (React 19 sets an <input>'s `type` first)
  const dom = await page.evaluate((ignoreClass) => {
    const serialize = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent
      if (node.nodeType !== Node.ELEMENT_NODE) return ''
      const attrs = [...node.attributes].filter((a) => !(ignoreClass && a.name === 'class')).map((a) => `${a.name}="${a.value}"`).sort().join(' ')
      return `<${node.localName}${attrs ? ' ' + attrs : ''}>${[...node.childNodes].map(serialize).join('')}</${node.localName}>`
    }
    const root = document.getElementById('root')
    // ids from React's useId (recharts uses them): `:r0:` in React 18, `_r_0_` in 19 — the same id either way
    return (root ? [...root.childNodes].map(serialize).join('') : '').replace(/:r[0-9a-z]+:|_r_[0-9a-z]+_|«r[0-9a-z]+»/g, '<useId>')
  }, IGNORE_CLASS)
  return { name, png, dom }
}

async function run(base, viewport, state) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', colorScheme: 'light' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const shots = []
  try {
    await page.goto(base + '/')
    await settle(page, 1000)
    shots.push(await shoot(page, 'login'))
    await page.fill('#email-input', PARITY_EMAIL)
    await page.fill('#password-input', PARITY_PASSWORD)
    await page.click('#connect-submit')
    await page.waitForSelector('#center-col', { timeout: 15000 })
    await settle(page)
    shots.push(await shoot(page, 'home'))
    for (const path of PAGES) {
      await page.goto(base + path)
      await page.waitForSelector('#center-col', { timeout: 15000 })
      await settle(page)
      shots.push(await shoot(page, path.slice(1).replace(/\//g, '_')))
    }
    await page.goto(base + '/')
    await page.waitForSelector('#center-col')
    await settle(page)
    const row = page.locator('.fh-history-chat-row').first()
    if (viewport.width < 1000 && state.chatPath) {
      // the sidebar is collapsed on a phone: open the chat by its URL
      await page.goto(base + state.chatPath)
      await page.waitForSelector('#center-col')
      await settle(page, 3500)
      shots.push(await shoot(page, 'chat'))
    } else if (await row.count()) {
      await row.click()
      await settle(page, 3500)
      state.chatPath = new URL(page.url()).pathname
      shots.push(await shoot(page, 'chat'))
      await row.hover()
      await page.locator('.fh-history-chat-row-menu-trigger').first().click()
      await page.waitForTimeout(300)
      await page.locator('.fh-history-chat-row-menu-popup .fh-menu-item').last().click()
      await page.waitForSelector('.fh-confirm-dialog')
      await page.waitForTimeout(300)
      shots.push(await shoot(page, 'confirm-delete'))
      await page.keyboard.press('Escape')
    }
  } finally {
    await context.close()
    await browser.close()
  }
  return { shots, errors }
}

let failed = false
// shared across viewports: the desktop run finds the chat's URL, the phone run opens it
const state = {}
for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
  const before = await run(OLD_URL, viewport, state)
  const after = await run(NEW_URL, viewport, state)
  for (const shot of before.shots) {
    const other = after.shots.find((candidate) => candidate.name === shot.name)
    const name = `${viewportName}-${shot.name}`
    if (!other) {
      failed = true
      console.log(`${name}: missing on NEW_URL`)
      continue
    }
    const a = PNG.sync.read(shot.png)
    const b = PNG.sync.read(other.png)
    const sameSize = a.width === b.width && a.height === b.height
    const diff = new PNG({ width: a.width, height: a.height })
    const pixels = sameSize ? pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 }) : -1
    const domSame = shot.dom === other.dom
    if (pixels !== 0 || !domSame) {
      failed = true
      writeFileSync(join(OUT, `${name}-old.png`), shot.png)
      writeFileSync(join(OUT, `${name}-new.png`), other.png)
      if (sameSize) writeFileSync(join(OUT, `${name}-diff.png`), PNG.sync.write(diff))
      writeFileSync(join(OUT, `${name}-old.html`), shot.dom)
      writeFileSync(join(OUT, `${name}-new.html`), other.dom)
    }
    console.log(`${name}: ${pixels === -1 ? 'size differs' : `${pixels} px different`}, DOM ${domSame ? 'same' : 'DIFFERENT'}`)
  }
  if (after.errors.length > before.errors.length) {
    failed = true
    console.log(`${viewportName}: new page errors: ${after.errors.join(' | ')}`)
  }
}
console.log(failed ? `\nDIFFERENT — see ${OUT}` : '\nidentical')
process.exit(failed ? 1 : 0)
