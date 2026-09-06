#!/usr/bin/env node
// 在不抢前台的隔离 Edge 中验证生产扩展赞赏窗口：双入口、多语言、键盘与亮暗主题。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const arg = (key, fallback) => {
  const index = process.argv.indexOf('--' + key)
  return index < 0 ? fallback : process.argv[index + 1]
}
const root = path.resolve(__dirname, '..')
const runtime = createRequire(
  path.join(arg('runtime', process.env.PLAYWRIGHT_ROOT), 'support-test.cjs')
)
const { chromium } = runtime('playwright')
const helper = require(arg('helper'))
const output = arg('output', '/private/tmp/fluentread-support-ui')
const report = {
  ok: false,
  extension: 'production chrome-mv3',
  cases: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
}

;(async () => {
  fs.mkdirSync(output, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-support-'))
  let launched
  try {
    launched = await helper.launchFocusSafePersistentContext({
      chromium,
      profileDir: profile,
      browserPath:
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      background: true,
      headless: false,
      viewport: { width: 1280, height: 800 },
      browserArgs: [
        `--disable-extensions-except=${root}/.output/chrome-mv3`,
        `--load-extension=${root}/.output/chrome-mv3`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      timeout: 30000,
    })
    Object.assign(report, {
      launchMode: launched.launchMode,
      focusPolicy: launched.focusPolicy,
      windowPlacement: launched.windowPlacement,
    })
    const context = launched.context
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker', { timeout: 30000 }))
    const origin = worker.url().split('/').slice(0, 3).join('/')
    const page = await helper.newPageWithoutForeground(context, 30000)
    page.on('pageerror', (e) => report.pageErrors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') report.consoleErrors.push(m.text())
    })
    await page.setViewportSize({ width: 360, height: 560 })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 560,
      deviceScaleFactor: 2,
      mobile: false,
    })
    await page.goto(origin + '/popup.html')
    await page.locator('[data-config-ready="true"]').waitFor()
    const patch = async (changes) => {
      const result = await page.evaluate(async (changes) => {
        const read = await chrome.runtime.sendMessage({
          type: 'configStorageRead',
          key: 'local:config',
        })
        if (!read.success) throw Error(read.error)
        const config =
          typeof read.value === 'string' ? JSON.parse(read.value) : read.value
        return chrome.runtime.sendMessage({
          type: 'persistConfig',
          mode: 'replace',
          baseRevision: config.__fluentConfigRevision,
          clientId: 'support-test-' + crypto.randomUUID(),
          sequence: 1,
          config: { ...config, ...changes },
        })
      }, changes)
      assert.equal(result.success, true, result.error)
      await page.reload()
      await page.locator('[data-config-ready="true"]').waitFor()
    }
    const open = async () => {
      await page.locator('.donation-button').click()
      await page.locator('.donation-card').waitFor()
      await page.waitForFunction(
        () => !document.querySelector('.donation-fade-enter-active')
      )
    }
    const shot = async (name) => {
      await page.evaluate(() => document.fonts.ready)
      const image = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      })
      const buffer = Buffer.from(image.data, 'base64')
      assert.equal(buffer.readUInt32BE(16), 720)
      assert.equal(buffer.readUInt32BE(20), 1120)
      const file = path.join(output, name + '.png')
      fs.writeFileSync(file, buffer)
      report.screenshots.push(file)
    }
    for (const locale of [
      'zh-CN',
      'en-US',
      'ja-JP',
      'ko-KR',
      'fr-FR',
      'ru-RU',
      'es-ES',
    ]) {
      await patch({
        uiLanguage: locale,
        uiLanguageSetupCompleted: true,
        theme: 'light',
      })
      await open()
      await page.locator('.donation-card').waitFor()
      await page
        .locator('.donation-qr-frame img')
        .evaluate((img) => img.decode())
      const metrics = await page.locator('.donation-card').evaluate((card) => {
        const bounds = card.getBoundingClientRect()
        const kofi = card.querySelector('.donation-kofi')
        const qr = card.querySelector('.donation-qr-frame')
        return {
          width: bounds.width,
          bottom: bounds.bottom,
          scrollHeight: card.scrollHeight,
          clientHeight: card.clientHeight,
          kofiBottom: kofi.getBoundingClientRect().bottom,
          qrWidth: qr.clientWidth,
          naturalWidth: qr.querySelector('img').naturalWidth,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        }
      })
      assert.equal(metrics.horizontalOverflow, false, locale)
      assert(
        metrics.bottom <= 560 && metrics.kofiBottom <= metrics.bottom,
        locale + ': both methods must fit'
      )
      assert(
        metrics.scrollHeight <= metrics.clientHeight + 1,
        locale + ': no scrolling at default size'
      )
      assert.equal(metrics.naturalWidth, 1152)
      assert.equal(metrics.qrWidth, 164)
      assert.equal(
        await page.locator('.donation-kofi').getAttribute('href'),
        'https://ko-fi.com/thinkstu'
      )
      assert.equal(
        await page.locator('.donation-kofi').getAttribute('target'),
        '_blank'
      )
      assert.match(
        await page.locator('.donation-kofi').getAttribute('rel'),
        /noopener/
      )
      assert.equal(
        await page.locator('.donation-qr-frame').getAttribute('href'),
        '/misc/approve.jpg'
      )
      assert.equal(
        await page
          .locator('.donation-close')
          .evaluate((el) => el === document.activeElement),
        true
      )
      await page.keyboard.press('Shift+Tab')
      assert.equal(
        await page
          .locator('.donation-kofi')
          .evaluate((el) => el === document.activeElement),
        true
      )
      await page.keyboard.press('Tab')
      assert.equal(
        await page
          .locator('.donation-close')
          .evaluate((el) => el === document.activeElement),
        true
      )
      await shot(locale + '-light')
      await page.keyboard.press('Escape')
      await page.locator('.donation-card').waitFor({ state: 'hidden' })
      assert.equal(
        await page
          .locator('.donation-button')
          .evaluate((el) => el === document.activeElement),
        true
      )
      await open()
      await page.locator('.donation-close').click()
      await page.locator('.donation-card').waitFor({ state: 'hidden' })
      report.cases.push({
        locale,
        metrics,
        keyboard: 'focus entry, wrap, Escape and return',
        closeButton: true,
      })
      if (locale === 'zh-CN' || locale === 'en-US') {
        await patch({ theme: 'dark' })
        await open()
        await shot(locale + '-dark')
        await page
          .locator('.donation-overlay')
          .click({ position: { x: 2, y: 2 } })
        await page.locator('.donation-card').waitFor({ state: 'hidden' })
      }
    }
    await page.setViewportSize({ width: 320, height: 400 })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 400,
      deviceScaleFactor: 2,
      mobile: false,
    })
    await open()
    await page.locator('.donation-kofi').scrollIntoViewIfNeeded()
    const compact = await page.locator('.donation-kofi').boundingBox()
    assert(compact.y >= 0 && compact.y + compact.height <= 400)
    report.cases.push({ compactViewport: '320x400', kofiReachable: true })
    assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors))
    assert.equal(
      report.consoleErrors.length,
      0,
      JSON.stringify(report.consoleErrors)
    )
    report.ok = true
  } catch (error) {
    report.error = error.stack
    process.exitCode = 1
  } finally {
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n'
    )
    if (launched) await launched.close()
    fs.rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })
    console.log(JSON.stringify(report, null, 2))
  }
})()
