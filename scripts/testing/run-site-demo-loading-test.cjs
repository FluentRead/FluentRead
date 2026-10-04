#!/usr/bin/env node
// 官网网页与漫画演示专项：真实点击、加载动画、完成停留、暂停和减少动态效果。
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
const { chromium } = createRequire(path.join(runtime, 'site-demo-test.cjs'))('playwright')
const root = path.resolve(__dirname, '../..')
const dist = path.join(root, 'docs/.vitepress/dist')
const output = path.resolve(argument('output', path.join(os.tmpdir(), 'fluentread-site-demo-loading')))
fs.mkdirSync(output, { recursive: true })
const report = {
  ok: false,
  launchMode: 'headless-isolated-chromium',
  focusPolicy: 'no-foreground-window-or-user-profile',
  windowPlacement: 'headless',
  cases: [],
  screenshots: [],
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
async function attribute(demo, name, value) {
  assert.equal(await demo.getAttribute(name), String(value), name)
}
async function loading(demo, kind) {
  await attribute(demo, 'data-loading', true)
  await attribute(demo, 'data-running', true)
  assert.equal(await demo.locator('.fd-stage').getAttribute('aria-busy'), 'true')
  assert(await demo.locator('.fd-spinner').isVisible())
  assert.equal(await demo.locator('.fd-spinner').evaluate(node => getComputedStyle(node).animationPlayState), 'running')
  const indicator = demo.locator(kind === 'webpage' ? '.fd-loading-bar' : '.fd-comic-scan').first()
  assert(await indicator.isVisible())
}
async function result(demo, kind) {
  await attribute(demo, 'data-loading', false)
  await attribute(demo, 'data-step', kind === 'webpage' ? 3 : 2)
  assert.equal(await demo.locator('.fd-stage').getAttribute('aria-busy'), 'false')
  assert.equal(await demo.locator('.fd-spinner').count(), 0)
  if (kind === 'webpage') {
    assert.equal(await demo.locator('.fd-translation[aria-hidden="false"]').count(), 2)
    for (const paragraph of await demo.locator('.fd-translation').all()) {
      assert.equal(await paragraph.evaluate(async node => {
        await Promise.all(node.getAnimations().map(animation => animation.finished))
        return getComputedStyle(node).opacity
      }), '1')
      assert((await paragraph.textContent()).trim().length > 10)
    }
  } else {
    assert.equal(await demo.locator('.fd-comic-scan').count(), 0)
    assert.equal(await demo.locator('.fd-bubble .fd-reveal').getAttribute('aria-hidden'), 'false')
  }
}
async function capture(demo, name) {
  const file = path.join(output, name + '.png')
  await demo.screenshot({ path: file })
  report.screenshots.push(file)
}
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch({ headless: true, executablePath: argument('browser-path') })
  for (const en of [false, true]) {
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 960 } })
      const page = await context.newPage()
      page.on('pageerror', error => report.pageErrors.push(error.message))
      await page.clock.install()
      await page.clock.pauseAt(new Date(Date.now() + 1000))
      try {
        await page.goto(base + (en ? '/en/' : '/'), { waitUntil: 'domcontentloaded' })
        for (const kind of ['webpage', 'image']) {
          const demo = page.locator('.fd-' + kind)
          const steps = demo.locator('.ds button')
          const name = `${en ? 'en' : 'zh'}-${width}-${kind}`
          await demo.scrollIntoViewIfNeeded()
          await page.locator(`.fd-${kind}[data-running="true"]`).waitFor()
          // 自动播放也必须经过加载状态；之后用真实点击检查手动播放。
          await page.clock.runFor(600)
          await loading(demo, kind)
          await steps.nth(0).click()
          await attribute(demo, 'data-step', 0)
          await attribute(demo, 'data-playing', false)
          assert((await demo.locator('.fd-status').textContent()).includes(en ? 'Ready' : '等待'))
          assert.equal(await demo.locator('.fd-spinner').count(), 0)
          assert((await steps.nth(1).getAttribute('aria-label')).includes(en ? 'Play the translation' : '演示翻译过程'))
          await steps.nth(1).click()
          await loading(demo, kind)
          // CSS 时间线的实际运动与 JS 步骤时钟分开采样，防止只验证动画名称。
          const first = await demo.locator('.fd-spinner').evaluate(node => getComputedStyle(node).transform)
          const scan = kind === 'image'
            ? await demo.locator('.fd-comic-scan').evaluate(node => getComputedStyle(node, '::after').top)
            : await demo.locator('.fd-loading-bar').first().evaluate(node => getComputedStyle(node, '::after').transform)
          await new Promise(resolve => setTimeout(resolve, 180))
          assert.notEqual(await demo.locator('.fd-spinner').evaluate(node => getComputedStyle(node).transform), first)
          assert.notEqual(kind === 'image'
            ? await demo.locator('.fd-comic-scan').evaluate(node => getComputedStyle(node, '::after').top)
            : await demo.locator('.fd-loading-bar').first().evaluate(node => getComputedStyle(node, '::after').transform), scan)
          await capture(demo, name + '-loading')
          assert(await demo.evaluate(node => node.scrollWidth <= node.clientWidth))
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          await page.clock.runFor(1200)
          if (kind === 'webpage') {
            await attribute(demo, 'data-step', 2)
            assert.equal(await demo.locator('.fd-loading-bar').count(), 1)
            assert.equal(await demo.locator('.fd-translation[aria-hidden="false"]').count(), 1)
            await page.clock.runFor(900)
          }
          await result(demo, kind)
          await attribute(demo, 'data-playing', false)
          await capture(demo, name + '-result')
          await page.clock.runFor(20000)
          await result(demo, kind)
          // 重复点击同一步重置加载；暂停保持进度，继续播放后完成。
          await steps.nth(1).click()
          await page.clock.runFor(400)
          await steps.nth(1).click()
          await page.clock.runFor(1199)
          await attribute(demo, 'data-step', 1)
          await demo.locator('.fd-footer button').first().click()
          await attribute(demo, 'data-running', false)
          assert.equal(await demo.locator('.fd-spinner').evaluate(node => getComputedStyle(node).animationPlayState), 'paused')
          await page.clock.runFor(5000)
          await attribute(demo, 'data-step', 1)
          await demo.locator('.fd-footer button').first().click()
          await page.clock.runFor(kind === 'webpage' ? 2100 : 1200)
          await result(demo, kind)
          // 跳到结果和重播必须清除单次播放的停止点。
          await steps.nth(1).click()
          await steps.nth(2).click()
          await attribute(demo, 'data-playing', false)
          await result(demo, kind)
          await demo.locator('.fd-footer button').last().click()
          await page.clock.runFor(8000)
          await attribute(demo, 'data-playing', true)
          await steps.nth(0).click()
          report.cases.push(name + ': autoplay, click, real CSS motion, result retention, repeat, pause/resume, replay and layout')
        }
        if (width === 1440) {
          for (const kind of ['selection', 'document', 'video']) {
            const demo = page.locator('.fd-' + kind)
            await demo.scrollIntoViewIfNeeded()
            const steps = demo.locator('.ds button')
            await steps.nth(1).click()
            await attribute(demo, 'data-playing', false)
            await steps.nth(1).click()
            await attribute(demo, 'data-playing', true)
          }
          report.cases.push(`${en ? 'en' : 'zh'}: other feature steps still pause and resume`)
        }
      } finally {
        await context.close()
      }
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 960 }, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      page.on('pageerror', error => report.pageErrors.push(error.message))
      await page.goto(base + (en ? '/en/' : '/'), { waitUntil: 'domcontentloaded' })
      for (const kind of ['webpage', 'image']) {
        const demo = page.locator('.fd-' + kind)
        await demo.locator('.ds button').nth(1).click()
        await result(demo, kind)
        await attribute(demo, 'data-playing', false)
        await capture(demo, `${en ? 'en' : 'zh'}-reduced-${kind}`)
      }
      report.cases.push(`${en ? 'en' : 'zh'}: reduced motion shows the result immediately without animated loading`)
    } finally {
      await context.close()
    }
  }
  assert.deepEqual(report.pageErrors, [])
  report.ok = true
})().catch(error => {
  report.failure = error.stack
  process.exitCode = 1
}).finally(async () => {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
})
