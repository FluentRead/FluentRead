#!/usr/bin/env node
// Capture current production extension UI in a fresh, focus-safe profile.
// Retain 2x source PNGs and lossless WebP; no credentials or live provider calls.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const arg = (name) => process.argv[process.argv.indexOf('--' + name) + 1]
const runtime = createRequire(path.join(arg('runtime'), 'docs-ui.cjs'))
const { chromium } = runtime('playwright'),
  sharp = runtime('sharp')
const helper = require(arg('helper'))
const root = path.resolve(__dirname, '..')
const report = {
  extension: '.output/chrome-mv3',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  version: JSON.parse(fs.readFileSync(path.join(root, '.output/chrome-mv3/manifest.json'), 'utf8')).version,
  scale: 2,
  screenshots: [],
  errors: [],
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-docs-ui-'))
let launched
const server = http.createServer((_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Reading example</title><main><h1>A world worth exploring.</h1><p>Every language offers a new way to see the world.</p></main></html>'
  )
})
;(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  launched = await helper.launchFocusSafePersistentContext({
    chromium,
    profileDir: profile,
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
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
  const ctx = launched.context
  const worker =
    ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 30000 }))
  const origin = worker.url().split('/').slice(0, 3).join('/')
  const create = async () => {
    const page = await helper.newPageWithoutForeground(ctx, 30000)
    page.on('pageerror', (e) => report.errors.push(e.message))
    return page
  }
  const article = await create()
  await article.goto('http://127.0.0.1:' + server.address().port)
  const popup = await create()
  await popup.goto(origin + '/popup.html')
  await popup.locator('.popup-shell[data-config-ready="true"]').waitFor()
  for (const locale of ['zh-CN', 'en-US']) {
    const result = await popup.evaluate(async (locale) => {
      const read = await chrome.runtime.sendMessage({
        type: 'configStorageRead',
        key: 'local:config',
      })
      if (!read.success) throw Error(read.error)
      const old = typeof read.value === 'string' ? JSON.parse(read.value) : read.value
      return chrome.runtime.sendMessage({
        type: 'persistConfig',
        mode: 'replace',
        baseRevision: old.__fluentConfigRevision,
        clientId: 'docs-ui-' + crypto.randomUUID(),
        sequence: 1,
        config: {
          ...old,
          uiLanguage: locale,
          uiLanguageSetupCompleted: true,
          service: 'freeTranslation',
          from: 'auto',
          to: locale === 'en-US' ? 'en' : 'zh-Hans',
        },
      })
    }, locale)
    assert.equal(result.success, true, result.error)
    await helper.activateExtensionTabWithoutForeground(ctx, article, 30000)
    await popup.reload()
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor()
    const sourceDir = path.join(root, 'marketing/source/site-ui', locale)
    const webDir = path.join(root, 'docs/public/screenshots/ui', locale)
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.mkdirSync(webDir, { recursive: true })
    async function capture(page, name, selector) {
      const w = name === 'popup' ? 360 : 1280,
        h = name === 'popup' ? 800 : 800
      await page.setViewportSize({ width: w, height: h })
      await page.evaluate(() => document.fonts.ready)
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 2,
        mobile: false,
      })
      const rect = selector
        ? await page.locator(selector).boundingBox()
        : { x: 0, y: 0, width: w, height: h }
      assert(rect, selector)
      const clip = {
        x: Math.floor(rect.x),
        y: Math.floor(rect.y),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
        scale: 1,
      }
      const data = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip,
      })
      const buffer = Buffer.from(data.data, 'base64'),
        source = path.join(sourceDir, name + '.png'),
        web = path.join(webDir, name + '.webp')
      fs.writeFileSync(source, buffer)
      await sharp(buffer).webp({ lossless: true, effort: 6 }).toFile(web)
      const meta = await sharp(web).metadata()
      assert.equal(meta.width, clip.width * 2)
      assert.equal(meta.height, clip.height * 2)
      assert(
        (await sharp(buffer).ensureAlpha().raw().toBuffer()).equals(
          await sharp(web).ensureAlpha().raw().toBuffer()
        )
      )
      report.screenshots.push({
        locale,
        name,
        source: path.relative(root, source),
        web: path.relative(root, web),
        width: meta.width,
        height: meta.height,
        bytes: fs.statSync(web).size,
        losslessPixels: true,
      })
      await cdp.detach()
    }
    await capture(popup, 'popup', '.popup-shell')
    const settings = await create()
    await settings.goto(origin + '/options.html#settings-general')
    await settings.locator('.sidebar').waitFor()
    await capture(settings, 'settings-general')
    await settings.locator('.sidebar [data-section="settings-services"]').click()
    await settings.locator('.service-catalog').waitFor()
    await capture(settings, 'settings-services')
    await settings.close()
  }
  assert.deepEqual(report.errors, [])
  fs.writeFileSync(
    path.join(root, 'marketing/site-ui-manifest.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  console.log(JSON.stringify(report))
})()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    if (launched) await launched.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(profile, { recursive: true, force: true })
  })
