#!/usr/bin/env node
// Built-site checks: locale preference, manual switching, complete bilingual routes,
// local links/assets, real pixel dimensions, and desktop/mobile screenshot evidence.
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict'),
  { createRequire } = require('node:module')
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n)
  return i < 0 ? d : process.argv[i + 1]
}
const root = path.resolve(__dirname, '..'),
  dist = path.join(root, 'docs/.vitepress/dist')
const runtime = createRequire(
  path.join(
    arg('runtime', process.env.PLAYWRIGHT_ROOT),
    'site-verification.cjs'
  )
)
const { chromium } = runtime('playwright'),
  sharp = runtime('sharp')
const { parseHTML } = require('linkedom')
const output = path.resolve(
  arg('output', '/private/tmp/fluentread-product-site-verification')
)
fs.mkdirSync(output, { recursive: true })
const files = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]
    )
const resolveFile = (url) => {
  let pathname = decodeURIComponent(new URL(url, 'http://test').pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  let file = path.join(dist, pathname)
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  if (fs.existsSync(file + '.html')) return file + '.html'
  return null
}
const report = {
  ok: false,
  pages: 0,
  links: 0,
  assets: 0,
  cases: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
}
;(async () => {
  const { preferredLocale, homeRedirect, localeBootstrap } = await import(
    '../docs/.vitepress/theme/locale-preference.mjs'
  )
  assert.equal(preferredLocale(null, ['fr-FR', 'zh-TW', 'en-US']), 'zh-CN')
  assert.equal(preferredLocale('zh-CN', ['en-US']), 'zh-CN')
  assert.equal(preferredLocale('en', ['zh-CN']), 'en')
  assert.equal(preferredLocale(null, ['ja-JP']), 'en')
  assert.equal(homeRedirect('/en/', '', '', null, ['zh-CN']), null)
  assert.equal(homeRedirect('/guide/features', '', '', null, ['en']), null)
  assert.equal(
    homeRedirect('/', '?ref=test', '#reading-title', null, ['en']),
    '/en/?ref=test#reading-title'
  )
  const sandbox = {
    location: {
      pathname: '/',
      search: '?q=1',
      hash: '#x',
      replace: (v) => (sandbox.result = v),
    },
    navigator: { languages: ['en-US'] },
    localStorage: {
      getItem: () => {
        throw Error('blocked')
      },
    },
  }
  require('node:vm').runInNewContext(localeBootstrap, sandbox)
  assert.equal(sandbox.result, '/en/?q=1#x')
  report.cases.push(
    'Language priority, stored override, explicit deep links, query/hash and blocked storage'
  )
  const zh = files(path.join(root, 'docs/guide'))
    .concat(files(path.join(root, 'docs/config')))
    .filter((f) => f.endsWith('.md'))
  for (const source of zh) {
    const twin = path.join(
      root,
      'docs/en',
      path.relative(path.join(root, 'docs'), source)
    )
    assert(fs.existsSync(twin), 'Missing English guide ' + source)
  }
  for (const file of files(dist).filter((f) => f.endsWith('.html'))) {
    const { document } = parseHTML(fs.readFileSync(file, 'utf8'))
    report.pages++
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')
      if (!href.startsWith('/') || href.startsWith('//')) continue
      const target = resolveFile(href)
      assert(target, `Missing internal link ${href} in ${file}`)
      report.links++
      const hash = new URL(href, 'http://test').hash
      if (hash && target.endsWith('.html')) {
        const { document: d } = parseHTML(fs.readFileSync(target, 'utf8'))
        assert(
          d.getElementById(decodeURIComponent(hash.slice(1))),
          `Missing anchor ${href} in ${file}`
        )
      }
    }
    for (const img of document.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src')
      if (src.startsWith('/')) {
        assert(resolveFile(src), 'Missing image ' + src)
        report.assets++
      }
    }
  }
  assert(
    !fs.existsSync(path.join(dist, 'maintainers')),
    'Maintainer references must not publish'
  )
  assert(
    !fs.existsSync(path.join(dist, 'marketing')),
    'Store material must not publish'
  )
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'marketing/asset-manifest.json'), 'utf8')
  )
  for (const e of manifest.entries) {
    const meta = await sharp(path.join(root, e.file)).metadata()
    if (e.kind === 'chrome-screenshot') {
      assert.equal(meta.width, 1280)
      assert.equal(meta.height, 800)
      assert.equal(meta.hasAlpha, false)
    }
    if (e.kind === 'web-lossless') {
      const source = await sharp(path.join(root, e.source)).metadata()
      const expected = e.source.includes('popup')
        ? [720, 1120]
        : e.source.includes('reading-card-detail')
        ? [840, 1140]
        : e.source.includes('selection-detail')
        ? [1400, 960]
        : [2560, 1600]
      assert.equal(source.width, expected[0], e.source)
      assert.equal(source.height, expected[1], e.source)
      assert.equal(meta.width, source.width)
    }
  }
  report.cases.push(
    'Chinese and English guide parity; built local links; anchors; actual 2x source images; Chrome sizes'
  )
  const server = http.createServer((req, res) => {
    const file = resolveFile(req.url)
    if (!file) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const ext = path.extname(file)
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
        '.json': 'application/json',
      }[ext] || 'application/octet-stream'
    )
    res.end(fs.readFileSync(file))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  })
  try {
    const attach = (p) => {
      p.on('pageerror', (e) => report.pageErrors.push(e.message))
      p.on('console', (m) => {
        if (m.type() === 'error') report.consoleErrors.push(m.text())
        if (m.type() === 'warning') console.log('BROWSER_WARNING', m.text())
      })
    }
    const shot = async (p, name) => {
      await p.evaluate(() => document.fonts.ready)
      const f = path.join(output, name + '.png')
      await p.screenshot({ path: f, fullPage: true, animations: 'disabled' })
      report.screenshots.push(f)
    }
    for (const locale of ['zh-CN', 'en-US']) {
      const ctx = await browser.newContext({
        locale,
        viewport: { width: 1440, height: 960 },
        deviceScaleFactor: 2,
      })
      const page = await ctx.newPage()
      attach(page)
      await page.goto(base + '/')
      await page.waitForLoadState('networkidle')
      assert.equal(
        new URL(page.url()).pathname,
        locale === 'zh-CN' ? '/' : '/en/'
      )
      assert.equal(
        await page.locator('html').getAttribute('lang'),
        locale === 'zh-CN' ? 'zh-CN' : 'en'
      )
      assert.match(
        await page.locator('h1').innerText(),
        locale === 'zh-CN' ? /外语/ : /Another language/
      )
      for (const img of await page
        .locator(
          '.product-main-shot img,.product-popup-shot img,.product-detail-shot img'
        )
        .all()) {
        await img.scrollIntoViewIfNeeded()
        await img.evaluate((i) => i.decode())
        const m = await img.evaluate((i) => ({
          src: i.currentSrc,
          display: i.clientWidth,
        }))
        const actualImage = await sharp(resolveFile(m.src)).metadata()
        assert(
          actualImage.width >= m.display * 1.95,
          JSON.stringify({ ...m, pixels: actualImage.width })
        )
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      )
      await page.evaluate(() => scrollTo(0, 0))
      await shot(page, locale + '-desktop')
      await page.getByRole('switch').first().click()
      await shot(page, locale + '-dark')
      await page.getByRole('switch').first().click()
      await page.setViewportSize({ width: 390, height: 844 })
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      )
      await shot(page, locale + '-mobile')
      await ctx.close()
    }
    report.cases.push(
      'Both locales: automatic home selection, real HiDPI display, desktop/mobile layout, dark theme'
    )
    const ctx = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 960 },
    })
    const page = await ctx.newPage()
    attach(page)
    await page.goto(base + '/')
    await page.locator('.VPNavBarTranslations button').click()
    await page
      .locator('.VPNavBarTranslations a')
      .filter({ hasText: 'English' })
      .click()
    await page.waitForURL('**/en/')
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem('fluentread-site-language')
      ),
      'en'
    )
    await page.goto(base + '/')
    await page.waitForURL('**/en/')
    await page.locator('.VPNavBarTranslations button').click()
    await page
      .locator('.VPNavBarTranslations a')
      .filter({ hasText: '简体中文' })
      .click()
    await page.waitForURL(base + '/')
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem('fluentread-site-language')
      ),
      'zh-CN'
    )
    await page.reload()
    assert.equal(new URL(page.url()).pathname, '/')
    await page.goto(base + '/guide/document-translation')
    await page.locator('.VPNavBarTranslations button').click()
    await page
      .locator('.VPNavBarTranslations a')
      .filter({ hasText: 'English' })
      .click()
    await page.waitForURL('**/en/guide/document-translation')
    assert.match(await page.locator('h1').innerText(), /document/)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.VPNavBarHamburger').click()
    await page.locator('.VPNavScreenTranslations button').click()
    await page.locator('.VPNavScreenTranslations a').click()
    await page.waitForURL('**/guide/document-translation')
    assert(!page.url().includes('/en/'))
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem('fluentread-site-language')
      ),
      'zh-CN'
    )
    await shot(page, 'guide-mobile-language-switch')
    await ctx.close()
    report.cases.push(
      'Manual desktop/mobile switch, remembered on reload, corresponding document route'
    )
    const noStorage = await browser.newContext({ locale: 'en-US' })
    await noStorage.addInitScript(() => {
      const get = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        if (key === 'fluentread-site-language')
          throw new DOMException('disabled', 'SecurityError')
        return get.call(this, key)
      }
    })
    const p = await noStorage.newPage()
    attach(p)
    await p.goto(base + '/')
    await p.waitForURL('**/en/')
    assert.match(await p.locator('h1').innerText(), /Another language/)
    await noStorage.close()
    assert.deepEqual(report.pageErrors, [])
    assert.deepEqual(report.consoleErrors, [])
    report.ok = true
  } finally {
    await browser.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})()
  .catch((e) => {
    report.error = e.stack
    process.exitCode = 1
    console.error(e)
  })
  .finally(() => {
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n'
    )
    console.log(JSON.stringify(report))
  })
