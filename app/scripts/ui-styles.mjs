#!/usr/bin/env node
// Computed-style parity (docs/ui-performance-plan.md §8): walks the same UI states on two running builds — menus,
// dialogs, every settings tab, hover, the project pages, Data Studio sections, dark theme, a narrow window, a phone —
// and compares getComputedStyle() of every element (and its ::before / ::after / ::placeholder), property by
// property. Stricter than screenshots: it sees what isn't on screen yet (a scrolled-away message, a hover colour of
// another row) and names the element and property that changed. The DOM structure must be the same in both; class
// attributes may differ (that is the point of moving styles into classes).
//
//   OLD_URL=http://localhost:18081 NEW_URL=http://localhost:8080 PARITY_EMAIL=... PARITY_PASSWORD=... \
//   node scripts/ui-styles.mjs [state-name-filter | name,name,…]
//
// The account must be an admin with at least one general chat and one project. Exit code 1 on any difference.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

const { OLD_URL, NEW_URL, PARITY_EMAIL, PARITY_PASSWORD } = process.env
if (!OLD_URL || !NEW_URL || !PARITY_EMAIL || !PARITY_PASSWORD) {
  console.error('set OLD_URL, NEW_URL, PARITY_EMAIL and PARITY_PASSWORD (see the header of this file)')
  process.exit(2)
}
const FILTER = process.argv[2]
const OUT = fileURLToPath(new URL('../.parity/styles/', import.meta.url))
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const settle = async (page, ms = 1200) => {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(ms)
}
const click = async (page, selector) => {
  await page.locator(selector).first().click()
  await page.waitForTimeout(400)
}
const goto = async (page, base, path) => {
  await page.goto(base + path)
  await page.waitForSelector('#center-col', { timeout: 15000 })
  await settle(page)
}
async function openSettings(page) {
  await click(page, '.fh-sidebar-account')
  await page.getByText('Cài đặt', { exact: true }).last().click()
  await page.waitForSelector('.fh-settings-nav')
  await page.waitForTimeout(500)
}
async function firstChat(page, base) {
  await goto(page, base, '/')
  await click(page, '.fh-history-chat-row')
  await page.waitForSelector('#log')
  await settle(page, 2500)
}

// [name, viewport, theme, steps(page, base)] — steps leave the page in the state to capture
const DESKTOP = { width: 1440, height: 900 }
const NARROW = { width: 900, height: 800 }
const PHONE = { width: 390, height: 844 }
const STATES = [
  ['login', DESKTOP, 'light', async () => {}],
  ['home', DESKTOP, 'light', async (p, b) => goto(p, b, '/')],
  ['home-search', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/'); await click(p, '.fh-sidebar-search-toggle') }],
  ['account-menu', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/'); await click(p, '.fh-sidebar-account') }],
  ['settings-general', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/'); await openSettings(p) }],
  ...[1, 2, 3].map((n) => [`settings-tab${n + 1}`, DESKTOP, 'light', async (p, b) => {
    await goto(p, b, '/'); await openSettings(p); await click(p, `.fh-settings-nav .fh-menu-item >> nth=${n}`); await settle(p)
  }]),
  ['chat', DESKTOP, 'light', async (p, b) => firstChat(p, b)],
  ['chat-row-hover', DESKTOP, 'light', async (p, b) => { await firstChat(p, b); await p.locator('.fh-history-chat-row').first().hover(); await p.waitForTimeout(300) }],
  ['chat-row-menu', DESKTOP, 'light', async (p, b) => {
    await firstChat(p, b); await p.locator('.fh-history-chat-row').first().hover(); await click(p, '.fh-history-chat-row-menu-trigger')
  }],
  ['chat-rename', DESKTOP, 'light', async (p, b) => {
    await firstChat(p, b); await p.locator('.fh-history-chat-row').first().hover(); await click(p, '.fh-history-chat-row-menu-trigger')
    await click(p, '.fh-history-chat-row-menu-popup .fh-menu-item >> nth=0')
  }],
  ['confirm-delete', DESKTOP, 'light', async (p, b) => {
    await firstChat(p, b); await p.locator('.fh-history-chat-row').first().hover(); await click(p, '.fh-history-chat-row-menu-trigger')
    await click(p, '.fh-history-chat-row-menu-popup .fh-menu-item >> nth=-1'); await p.waitForSelector('.fh-confirm-dialog')
  }],
  ['data', DESKTOP, 'light', async (p, b) => goto(p, b, '/data')],
  ['data-create', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/data'); await click(p, '.fh-hub-create-open') }],
  ['data-sidebar-create', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/data'); await click(p, '.fh-sidebar-projects-action >> nth=1') }],
  ['project', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/data'); await click(p, '.fh-hub-project-row'); await settle(p) }],
  ...['sources', 'outputs'].map((tab) => [`project-${tab}`, DESKTOP, 'light', async (p, b) => {
    await goto(p, b, '/data'); await click(p, '.fh-hub-project-row'); await settle(p); await click(p, `[class*="fh-hub-tab-${tab}"]`); await settle(p)
  }]),
  ['skills', DESKTOP, 'light', async (p, b) => goto(p, b, '/my-skills')],
  ['usage', DESKTOP, 'light', async (p, b) => goto(p, b, '/admin/usage')],
  ...[0, 1, 2, 3].map((n) => [`data-studio-${n}`, DESKTOP, 'light', async (p, b) => {
    await goto(p, b, '/data-studio'); await click(p, `.fh-data-studio-nav-item >> nth=${n}`); await settle(p, 2000)
  }]),
  ['composer-typed', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/'); await p.locator('#text-input').fill('Xin chào') }],
  ['skill-menu', DESKTOP, 'light', async (p, b) => { await goto(p, b, '/'); await p.locator('#text-input').fill('/'); await p.waitForTimeout(600) }],
  ['attachments', DESKTOP, 'light', async (p, b) => {
    await goto(p, b, '/')
    await p.locator('#center-col input[type=file]').first().setInputFiles({ name: 'ui-check.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') })
    await settle(p, 2500)
  }],
  ['toast', DESKTOP, 'light', async (p, b) => {
    // a rename over 255 characters: refused in the browser with an error toast (nothing is sent)
    await firstChat(p, b); await p.locator('.fh-history-chat-row').first().hover(); await click(p, '.fh-history-chat-row-menu-trigger')
    await click(p, '.fh-history-chat-row-menu-popup .fh-menu-item >> nth=0')
    await p.locator('.fh-history-chat-row input').fill('x'.repeat(300)); await p.keyboard.press('Enter'); await p.waitForTimeout(800)
  }],
  ['dark-home', DESKTOP, 'dark', async (p, b) => goto(p, b, '/')],
  ['dark-chat', DESKTOP, 'dark', async (p, b) => firstChat(p, b)],
  ['dark-settings', DESKTOP, 'dark', async (p, b) => { await goto(p, b, '/'); await openSettings(p) }],
  ['dark-data', DESKTOP, 'dark', async (p, b) => goto(p, b, '/data')],
  ['dark-usage', DESKTOP, 'dark', async (p, b) => goto(p, b, '/admin/usage')],
  ['narrow-home', NARROW, 'light', async (p, b) => goto(p, b, '/')],
  ['narrow-sidebar-open', NARROW, 'light', async (p, b) => { await goto(p, b, '/'); await click(p, '.fh-sidebar-collapse-toggle') }],
  ['phone-login', PHONE, 'light', async () => {}],
  ['login-error', DESKTOP, 'light', async () => {}],
  ['phone-home', PHONE, 'light', async (p, b) => goto(p, b, '/')],
  ['phone-chat', PHONE, 'light', async (p, b) => { await goto(p, b, '/'); await p.goto(b + (await chatPath(p))); await p.waitForSelector('#log'); await settle(p, 2500) }],
  ['phone-data', PHONE, 'light', async (p, b) => goto(p, b, '/data')],
].filter(([name]) => !FILTER || FILTER.split(',').some((f) => name === f || (!FILTER.includes(',') && name.includes(f))))

async function chatPath(page) {
  return page.evaluate(async () => {
    const res = await fetch('/sessions/mine', { headers: { authorization: `Bearer ${localStorage.getItem('fox-harness/token')}` } })
    const rows = await res.json()
    return `/chat/${rows.find((row) => row.flow !== 'data-analysis' && row.flow !== 'data-studio').sessionId}`
  })
}

// Every element's computed style (+ pseudo elements), keyed by its position in the tree.
function snapshot() {
  for (const animation of document.getAnimations()) {
    animation.pause()
    animation.currentTime = 0
  }
  const out = {}
  const props = (style) => {
    const parts = []
    // standard properties only: custom properties (--*) are inputs, their effect shows in the standard ones, and
    // their raw text changes with minification (0.4 vs .4) or Tailwind's --tw-* defaults
    for (let i = 0; i < style.length; i++) if (!style[i].startsWith('--')) parts.push(`${style[i]}:${style.getPropertyValue(style[i])}`)
    return parts.join('\n')
  }
  const walk = (el, path) => {
    const label = `${el.localName}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].filter((c) => /^(fh|ds|chart|bubble|assistant|notice|hljs)/.test(c)).slice(0, 3).join('.')}` : ''}`
    out[path] = { label, style: props(getComputedStyle(el)) }
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(el, pseudo)
      if (style.content && style.content !== 'none' && style.content !== 'normal') out[`${path}${pseudo}`] = { label: label + pseudo, style: props(style) }
    }
    if (el.localName === 'input' || el.localName === 'textarea') out[`${path}::placeholder`] = { label: `${label}::placeholder`, style: props(getComputedStyle(el, '::placeholder')) }
    // only what renders: <head>, scripts and preload links differ between build setups and draw nothing
    let i = 0
    for (const child of el.children) if (!SKIP.has(child.localName) && !SKIP_IDS.has(child.id)) walk(child, `${path}/${i++}`)
  }
  const SKIP = new Set(['head', 'script', 'style', 'link', 'meta', 'template', 'noscript'])
  // recharts' hidden text-measuring span keeps whatever it measured last: not part of the page
  const SKIP_IDS = new Set(['recharts_measurement_span'])
  walk(document.documentElement, 'html')
  return out
}

// One sign-in per build (the gateway rate-limits /auth/login); each state starts from that stored session.
const sessions = new Map()
async function signIn(browser, base) {
  if (sessions.has(base)) return sessions.get(base)
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(base + '/')
  await page.fill('#email-input', PARITY_EMAIL)
  await page.fill('#password-input', PARITY_PASSWORD)
  await page.click('#connect-submit')
  await page.waitForSelector('#center-col', { timeout: 15000 })
  const state = await context.storageState()
  await context.close()
  sessions.set(base, state)
  return state
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
async function capture(base, [name, viewport, theme, steps]) {
  const loggedOut = name.endsWith('login') || name === 'login-error'
  const storageState = loggedOut ? undefined : await signIn(browser, base)
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', colorScheme: 'light', storageState })
  await context.addInitScript((value) => {
    try {
      if (value === 'dark') localStorage.setItem('fox-harness/theme', 'dark')
    } catch {}
  }, theme)
  const page = await context.newPage()
  try {
    await page.goto(base + '/')
    if (loggedOut) {
      await page.waitForSelector('#connect-form')
      if (name === 'login-error') {
        await page.fill('#email-input', 'nobody@fox.test')
        await page.fill('#password-input', 'wrong-password')
        await page.click('#connect-submit')
        await page.waitForSelector('#connect-error')
      }
      await settle(page, 800)
    } else {
      await page.waitForSelector('#center-col', { timeout: 15000 })
      await settle(page, 800)
      await steps(page, base)
    }
    if (!name.includes('hover')) await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    return await page.evaluate(snapshot)
  } finally {
    await context.close()
  }
}

let failed = 0
for (const state of STATES) {
  const [before, after] = [await capture(OLD_URL, state), await capture(NEW_URL, state)]
  const lines = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const a = before[key]
    const b = after[key]
    if (!a || !b) {
      lines.push(`${key} ${a?.label ?? b?.label}: only in ${a ? 'OLD' : 'NEW'}`)
      continue
    }
    if (a.style === b.style) continue
    const mapA = new Map(a.style.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]))
    const mapB = new Map(b.style.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]))
    for (const [prop, value] of mapA) if (mapB.get(prop) !== value) lines.push(`${key} ${a.label} { ${prop}: ${value} -> ${mapB.get(prop)} }`)
  }
  const elements = Object.keys(before).length
  if (lines.length) {
    failed++
    writeFileSync(join(OUT, `${state[0]}.txt`), lines.join('\n') + '\n')
    console.log(`${state[0]}: ${lines.length} differences (${elements} elements) — .parity/styles/${state[0]}.txt`)
  } else console.log(`${state[0]}: same (${elements} elements)`)
}
await browser.close()
console.log(failed ? `\n${failed} state(s) DIFFERENT` : '\nall states identical')
process.exit(failed ? 1 : 0)
