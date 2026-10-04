#!/usr/bin/env node
// 官网介绍视频专项：隔离无窗口浏览器、真实视频解码、可控网络与时钟，不访问用户 profile。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const argument = (name, fallback) => {
  const index = process.argv.indexOf('--' + name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const runtime = argument('playwright-root', process.env.PLAYWRIGHT_ROOT)
assert(runtime, 'Pass --playwright-root or PLAYWRIGHT_ROOT')
const { chromium } = createRequire(path.join(runtime, 'site-video-test.cjs'))('playwright')
const root = path.resolve(__dirname, '../..')
const dist = path.join(root, 'docs/.vitepress/dist')
const output = path.resolve(argument('output', path.join(os.tmpdir(), 'fluentread-site-video-fallback')))
fs.mkdirSync(output, { recursive: true })
const report = {
  ok: false,
  launchMode: 'headless-isolated-chromium',
  focusPolicy: 'no-foreground-window-or-user-profile',
  windowPlacement: 'headless',
  cases: [],
  pageErrors: [],
}
const server = http.createServer((request, response) => {
  let route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  if (route.endsWith('/')) route += 'index.html'
  let file = path.join(dist, route)
  if (!fs.existsSync(file)) file += '.html'
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404)
    response.end()
    return
  }
  response.setHeader('Content-Type', {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  }[path.extname(file)] || 'application/octet-stream')
  fs.createReadStream(file).pipe(response)
})
let browser
async function runCase(name, scenario) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const requests = []
  context.on('request', request => requests.push(request.url()))
  // 确定性用例只检查回退播放器的接入，不依赖 B 站实时网络与风控。
  await context.route('https://player.bilibili.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<html><body>Bilibili fixture</body></html>',
  }))
  const page = await context.newPage()
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  try {
    await scenario({ context, page, requests })
    report.cases.push(name)
  } finally {
    await context.close()
  }
}
const native = page => page.locator('.bv-promo video')
const fallback = page => page.locator('.bv-promo iframe')
const videoUrl = '**/videos/fluentread-promo-zh.mp4'
async function beginLoading(page, base) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('.bv-promo').scrollIntoViewIfNeeded()
  await page.waitForFunction(() => document.querySelector('.bv-promo video')?.preload === 'auto')
}
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch({ headless: true, executablePath: argument('browser-path') })
  await runCase('Original cover stays visible offscreen without loading either player', async ({ page, requests }) => {
    await page.setViewportSize({ width: 1280, height: 240 })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__))
    const bounds = await native(page).boundingBox()
    assert(bounds.y > 440, 'Video must begin outside the prefetch margin in this case')
    assert.equal(await native(page).getAttribute('poster'), '/videos/fluentread-promo-zh-poster.webp')
    await page.clock.fastForward(60000)
    assert.equal(await native(page).count(), 1)
    assert.equal(await fallback(page).count(), 0)
    assert(!requests.some(url => url.includes('/videos/fluentread-promo-zh.mp4') || url.includes('player.bilibili.com')))
  })
  await runCase('Healthy video stays native and paused after the timeout window', async ({ page }) => {
    await beginLoading(page, base)
    await page.waitForFunction(() => document.querySelector('.bv-promo video')?.readyState >= 3)
    assert.equal(await native(page).evaluate(video => video.paused), true)
    await page.clock.fastForward(20000)
    assert.equal(await fallback(page).count(), 0)
    await page.clock.resume()
    await native(page).evaluate(video => video.play())
    await page.waitForFunction(() => document.querySelector('.bv-promo video')?.currentTime > 0)
    await native(page).evaluate(video => video.pause())
    await page.locator('.bv-promo').screenshot({ path: path.join(output, 'native-desktop.png') })
  })
  await runCase('Stalled video stays native until 8 seconds then switches and releases its source', async ({ context, page }) => {
    await context.route(videoUrl, () => {})
    await beginLoading(page, base)
    const original = await native(page).elementHandle()
    await page.clock.fastForward(7999)
    assert.equal(await fallback(page).count(), 0)
    assert.equal(await native(page).count(), 1)
    await page.clock.fastForward(1)
    await fallback(page).waitFor()
    assert.equal(await native(page).count(), 0)
    const url = new URL(await fallback(page).getAttribute('src'))
    assert.equal(url.origin, 'https://player.bilibili.com')
    assert.equal(url.searchParams.get('bvid'), 'BV1VLHE6hEnB')
    assert.equal(url.searchParams.get('autoplay'), '0')
    assert.equal(url.searchParams.get('danmaku'), '0')
    assert.equal(await original.evaluate(video => video.querySelector('source').hasAttribute('src')), false)
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 960 })
      const rect = await fallback(page).boundingBox()
      assert(Math.abs(rect.width / rect.height - 16 / 9) < 0.01)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
    await page.locator('.bv-promo').screenshot({ path: path.join(output, 'fallback-mobile.png') })
  })
  await runCase('Video becoming playable at 6.5 seconds stays native', async ({ context, page }) => {
    let pending
    await context.route(videoUrl, route => { pending = route })
    const requestStarted = page.waitForRequest(videoUrl)
    await beginLoading(page, base)
    await requestStarted
    assert(pending)
    await page.clock.fastForward(6500)
    await pending.fulfill({ contentType: 'video/mp4', body: fs.readFileSync(path.join(dist, 'videos/fluentread-promo-zh.mp4')) })
    await page.waitForFunction(() => document.querySelector('.bv-promo video')?.readyState >= 3)
    await page.clock.fastForward(10000)
    assert.equal(await native(page).count(), 1)
    assert.equal(await fallback(page).count(), 0)
  })
  await runCase('Explicit network failure switches immediately', async ({ context, page }) => {
    await context.route(videoUrl, route => route.abort('failed'))
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
    await page.locator('.bv-promo').scrollIntoViewIfNeeded()
    await fallback(page).waitFor()
    assert.equal(await native(page).count(), 0)
  })
  await runCase('Language navigation cancels the pending source and leaves English on its original video', async ({ context, page }) => {
    await context.route(videoUrl, () => {})
    await beginLoading(page, base)
    const original = await native(page).elementHandle()
    await page.clock.fastForward(2000)
    await page.locator('.bv-language').click()
    await page.waitForURL(base + '/en/')
    await native(page).waitFor()
    await page.clock.fastForward(20000)
    assert.equal(await original.evaluate(video => video.querySelector('source').hasAttribute('src')), false)
    assert.equal(await fallback(page).count(), 0)
    assert.equal(await native(page).locator('source').getAttribute('src'), '/videos/fluentread-promo-en.mp4')
    assert.equal(await native(page).getAttribute('preload'), 'none')
  })
  assert.deepEqual(report.pageErrors, [])
  report.ok = true
})().catch(error => {
  report.error = error.stack
  process.exitCode = 1
}).finally(async () => {
  if (browser) await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
})
