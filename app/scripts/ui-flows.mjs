#!/usr/bin/env node
// Navigation behaviour check (docs/ui-performance-plan.md §3): what ui-parity.mjs can't see — URLs, Back/Forward,
// reloads, deep links through the login screen, the chat socket following the URL. Run against one build:
//
//   APP_URL=http://localhost:8080 PARITY_EMAIL=... PARITY_PASSWORD=... node scripts/ui-flows.mjs
//
// The account needs to be an admin with at least one general chat (no message is sent, nothing is changed).
// Exit code 1 on the first failure, with the step that failed.
import { chromium } from 'playwright-core'

const { APP_URL, PARITY_EMAIL, PARITY_PASSWORD } = process.env
if (!APP_URL || !PARITY_EMAIL || !PARITY_PASSWORD) {
  console.error('set APP_URL, PARITY_EMAIL and PARITY_PASSWORD (see the header of this file)')
  process.exit(2)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const sockets = []
page.on('websocket', (socket) => {
  const path = new URL(socket.url()).pathname
  if (path.startsWith('/sessions/')) sockets.push(path)
})

const path = () => new URL(page.url()).pathname
let step = ''
let passed = 0
async function check(name, fn) {
  step = name
  await fn()
  passed++
  console.log(`ok  ${name}`)
}
function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const visible = (selector) => page.waitForSelector(selector, { state: 'visible', timeout: 15000 })
async function login() {
  await visible('#connect-form')
  await page.fill('#email-input', PARITY_EMAIL)
  await page.fill('#password-input', PARITY_PASSWORD)
  await page.click('#connect-submit')
  await visible('#center-col')
}

try {
  await check('deep link while logged out survives the login screen', async () => {
    await page.goto(`${APP_URL}/data`)
    await login()
    await visible('.fh-hub')
    expectEqual(path(), '/data', 'URL after login')
  })

  await check('reload keeps every page', async () => {
    for (const [url, selector] of [
      ['/data', '.fh-hub'],
      ['/my-skills', '.fh-skills-page'],
      ['/admin/usage', '.fh-usage'],
      ['/data-studio', '#center-col'],
      ['/', '#center-col'],
    ]) {
      await page.goto(APP_URL + url)
      await visible(selector)
      await page.reload()
      await visible(selector)
      expectEqual(path(), url, `URL after reloading ${url}`)
    }
  })

  await check('an unknown path goes home', async () => {
    await page.goto(`${APP_URL}/no/such/page`)
    await visible('#center-col')
    await page.waitForFunction(() => location.pathname === '/')
  })

  let chatUrl = ''
  await check('opening a chat pushes its URL and connects to it', async () => {
    await page.goto(`${APP_URL}/`)
    await visible('.fh-history-chat-row')
    await page.locator('.fh-history-chat-row').first().click()
    await page.waitForFunction(() => location.pathname.startsWith('/chat/'))
    chatUrl = path()
    await visible('#log')
    await page.waitForFunction((id) => true, chatUrl)
    if (!sockets.includes(`/sessions/${chatUrl.split('/')[2]}`)) throw new Error(`no socket to ${chatUrl}: ${sockets.join(', ')}`)
  })

  await check('Back returns to the new chat, Forward to the chat again', async () => {
    await page.goBack()
    await page.waitForFunction(() => location.pathname === '/')
    await visible('.fh-conversation-empty')
    await page.goForward()
    await page.waitForFunction((url) => location.pathname === url, chatUrl)
    await visible('#log')
  })

  await check('reloading a chat URL resumes that chat', async () => {
    await page.reload()
    await visible('#log')
    expectEqual(path(), chatUrl, 'URL after reload')
  })

  await check('a page opened from a chat goes back to it', async () => {
    await page.locator('.fh-sidebar-skills').click()
    await page.waitForFunction(() => location.pathname === '/my-skills')
    await visible('.fh-skills-page')
    await page.locator('.fh-skills-page .fh-usage-icon-btn').first().click()
    await page.waitForFunction((url) => location.pathname === url, chatUrl)
    await visible('#log')
  })

  await check('the data area and Back', async () => {
    await page.locator('.fh-sidebar-data-analysis').click()
    await page.waitForFunction(() => location.pathname === '/data')
    await visible('.fh-hub')
    await page.goBack()
    await page.waitForFunction((url) => location.pathname === url, chatUrl)
    await visible('#log')
  })

  await check('New chat leaves the chat for an empty one at /', async () => {
    await page.getByText('Trò chuyện mới', { exact: true }).click()
    await page.waitForFunction(() => location.pathname === '/')
    await visible('.fh-conversation-empty')
  })

  await check('logout clears the URL and shows the login form', async () => {
    await page.goto(APP_URL + chatUrl)
    await visible('#log')
    await page.locator('.fh-sidebar-account').click()
    await page.getByText('Đăng xuất', { exact: true }).click()
    await visible('#connect-form')
    expectEqual(path(), '/', 'URL after logout')
  })

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
  console.log(`\n${passed} flows passed`)
} catch (error) {
  console.log(`FAIL ${step}\n  ${error instanceof Error ? error.message.split('\n')[0] : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
