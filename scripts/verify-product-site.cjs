#!/usr/bin/env node
// Built-site checks: fixed public URLs, manual switching, complete bilingual routes,
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
  path.join(arg('runtime', process.env.PLAYWRIGHT_ROOT), 'site-verification.cjs')
)
const { chromium } = runtime('playwright'),
  sharp = runtime('sharp')
const { parseHTML } = require('linkedom')
const output = path.resolve(arg('output', '/private/tmp/fluentread-product-site-verification'))
fs.mkdirSync(output, { recursive: true })
const files = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
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
  launchMode: 'chromium-headless',
  focusPolicy: 'isolated-contexts-no-foreground',
  windowPlacement: 'headless-no-visible-window',
  pages: 0,
  links: 0,
  assets: 0,
  cases: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
}
const contrast = (foreground, background) => {
  const luminance = (color) => {
    const channels = color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((n) => {
        n /= 255
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
      })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const a = luminance(foreground),
    b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
;(async () => {
  for (const prefix of ['', '/en']) {
    const { document } = parseHTML(fs.readFileSync(resolveFile(prefix + '/'), 'utf8'))
    assert.equal(document.title, 'FluentRead')
    assert.equal(
      document.querySelector('h1').textContent.trim(),
      prefix ? 'Closer languages. A bigger world.' : '让语言更近，让世界更大。'
    )
    assert.equal(
      document.querySelector('.product-tagline').textContent.trim(),
      prefix ? 'Closer languages. A bigger world.' : '让语言更近，让世界更大。'
    )
    assert(document.querySelector(`.fr-control-notes a[href="${prefix}/guide/privacy"]`))
    assert(!document.querySelector('input[type="password"]'))
    const policy = parseHTML(
      fs.readFileSync(resolveFile(prefix + '/guide/privacy'), 'utf8')
    ).document.querySelector('.vp-doc').textContent
    assert(policy.includes('drive.appdata'))
    assert(policy.includes(prefix ? 'Data category' : '数据类别'))
    assert(policy.includes(prefix ? 'Storage location' : '保存位置'))
  }
  assert(
    !fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes('让语言更近，让世界更大。')
  )
  assert(
    !fs
      .readFileSync(path.join(root, 'misc/README_ZH.md'), 'utf8')
      .includes('Closer languages. A bigger world.')
  )
  report.cases.push(
    'Public server-rendered app identity, single-language slogans, policy links and data disclosures'
  )
  const zh = files(path.join(root, 'docs/guide'))
    .concat(files(path.join(root, 'docs/config')))
    .filter((f) => f.endsWith('.md'))
  for (const source of zh) {
    const twin = path.join(root, 'docs/en', path.relative(path.join(root, 'docs'), source))
    assert(fs.existsSync(twin), 'Missing English guide ' + source)
  }
  const oauthPages = new Set([
    'index.html',
    'en/index.html',
    'guide/privacy.html',
    'en/guide/privacy.html',
    'guide/privacy-policy.html',
    'en/guide/privacy-policy.html',
  ])
  const onlyOAuth = process.argv.includes('--oauth-only')
  for (const file of files(dist).filter(
    (f) => f.endsWith('.html') && (!onlyOAuth || oauthPages.has(path.relative(dist, f)))
  )) {
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
  assert(!fs.existsSync(path.join(dist, 'maintainers')), 'Maintainer references must not publish')
  assert(!fs.existsSync(path.join(dist, 'marketing')), 'Store material must not publish')
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
  if (process.argv.includes('--static-only')) {
    report.ok = true
    report.scope = `${
      onlyOAuth ? 'Homepage and privacy-policy' : 'Built'
    } HTML, links, assets and source image dimensions; browser interaction not executed`
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify({
        ok: report.ok,
        pages: report.pages,
        links: report.links,
        assets: report.assets,
        cases: report.cases,
        report: path.join(output, 'report.json'),
      })
    )
    return
  }
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
    executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  })
  try {
    const attach = (p) => {
      p.on('pageerror', (e) => report.pageErrors.push(e.message))
      p.on('console', (m) => {
        if (m.type() === 'error') report.consoleErrors.push(m.text())
        if (m.type() === 'warning') console.log('BROWSER_WARNING', m.text())
      })
    }
    const audit = await browser.newContext({ viewport: { width: 1440, height: 960 } })
    const auditPage = await audit.newPage()
    attach(auditPage)
    for (const file of files(dist).filter((f) => f.endsWith('.html') && !f.endsWith('/404.html'))) {
      const route = '/' + path.relative(dist, file).replace(/index\.html$/, '').replace(/\.html$/, '')
      await auditPage.goto(base + route)
      await auditPage.locator('h1').waitFor()
      for (const width of [1440, 390]) {
        await auditPage.setViewportSize({ width, height: 960 })
        assert.equal(
          await auditPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          route + ' overflows at ' + width
        )
      }
      if (route === '/' || route === '/en/') {
        assert.equal(await auditPage.locator('.fr-site').count(), 1)
        assert.equal(await auditPage.locator('.fr-hero').count(), 1)
      }
    }
    await audit.close()
    report.cases.push('Every public page renders at desktop and mobile widths without document overflow')
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
      assert.equal(new URL(page.url()).pathname, '/')
      assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
      if (locale === 'en-US') await page.goto(base + '/en/')
      assert.equal(
        await page.locator('html').getAttribute('lang'),
        locale === 'zh-CN' ? 'zh-CN' : 'en'
      )
      assert.equal(
        await page.locator('h1').innerText(),
        locale === 'zh-CN' ? '让语言更近，让世界更大。' : 'Closer languages. A bigger world.'
      )
      for (const img of await page.locator('.fr-install-shot img').all()) {
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
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      await page.evaluate(() => scrollTo(0, 0))
      await shot(page, locale + '-desktop')
      await page.screenshot({
        path: path.join(output, locale + '-hero.png'),
        animations: 'disabled',
      })
      const reader = page.locator('[data-demo="reader"]')
      const en = locale === 'en-US'
      await reader.getByRole('button', { name: en ? 'Translation' : '仅译文', exact: true }).click()
      assert.equal(await reader.locator('.fr-demo-original').count(), 0)
      assert.equal(await reader.locator('.fr-demo-translated').count(), 3)
      await reader.getByRole('button', { name: en ? 'Original' : '原文', exact: true }).click()
      assert.equal(await reader.locator('.fr-demo-translated').count(), 0)
      await reader.getByRole('button', { name: en ? 'Selection' : '划词翻译', exact: true }).click()
      await reader.locator('.fr-demo-selected').click()
      assert(await reader.locator('.fr-demo-selection-result').isVisible())
      await reader.getByRole('button', { name: en ? 'Replay' : '重播演示', exact: true }).click()
      assert.equal(await reader.locator('.fr-demo-translated').count(), 3)
      const grammar = page.locator('[data-demo="grammar"]')
      await grammar.locator('.fr-grammar-parts button').nth(1).click()
      assert((await grammar.locator('.fr-grammar-detail').innerText()).includes('offers'))
      await grammar.locator('.fr-grammar-parts button').nth(1).press('ArrowRight')
      assert((await grammar.locator('.fr-grammar-detail').innerText()).includes('a new way'))
      await grammar.screenshot({
        path: path.join(output, locale + '-grammar.png'),
        animations: 'disabled',
      })
      const card = page.locator('[data-demo="card"]')
      await card.getByRole('button', { name: en ? 'Practice' : '练习', exact: true }).click()
      await card
        .getByRole('button', { name: en ? 'Show an answer' : '查看参考答案', exact: true })
        .click()
      assert((await card.innerText()).includes('Reading offers a new way to understand others.'))
      await page
        .locator('[data-demo="subtitles"]')
        .getByRole('button', { name: en ? 'Line 2' : '第 2 句', exact: true })
        .click()
      assert((await page.locator('.fr-demo-caption').innerText()).includes('Stay curious.'))
      await page.evaluate(() => scrollTo(0, 0))
      report.cases.push(
        locale +
          ': bilingual / translation / restore / selection / replay; phrase keyboard navigation; AI example; subtitle switch'
      )
      await page.getByRole('switch').first().click()
      await shot(page, locale + '-dark')
      await page.getByRole('switch').first().click()
      await page.setViewportSize({ width: 390, height: 844 })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      await shot(page, locale + '-mobile')
      for (const section of ['.fr-hero', '[data-demo="grammar"]', '.fr-start', '.fr-end']) {
        const target = page.locator(section)
        assert.equal(await target.count(), 1)
        await target.screenshot({
          path: path.join(output, locale + '-mobile-' + section.replace(/[^a-z]+/g, '-') + '.png'),
          animations: 'disabled',
        })
      }
      for (const width of [320, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 })
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          locale + ' homepage at ' + width
        )
      }
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.goto(base + (en ? '/en/docs/' : '/docs/'))
      assert.equal(await page.locator('.fr-docs-grid a').count(), 16)
      for (const dark of [false, true]) {
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
        const colors = await page.locator('.fr-docs .fr-primary').evaluate((a) => {
          const s = getComputedStyle(a)
          return { foreground: s.color, background: s.backgroundColor }
        })
        assert(contrast(colors.foreground, colors.background) >= 4.5, JSON.stringify(colors))
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await shot(page, locale + '-docs-desktop')
      await page.locator('.VPNavBarSearch button').click()
      const search = page.locator('#localsearch-input')
      await search.fill(en ? 'Input translation' : '输入框翻译')
      await page.locator('.VPLocalSearchBox .results a').first().waitFor()
      assert(
        (await page.locator('.VPLocalSearchBox .results').innerText()).includes(
          en ? 'Input translation' : '输入框翻译'
        )
      )
      await search.press('Escape')
      await page.goto(base + (en ? '/en/guide/input-translation' : '/guide/input-translation'))
      const input = page.locator('[data-demo="input"]')
      await input
        .getByRole('button', { name: en ? 'Translate example' : '翻译示例', exact: true })
        .click()
      assert.equal(await input.locator('.fr-demo-translated').count(), 1)
      await input
        .getByRole('button', { name: en ? 'Restore original' : '恢复原文', exact: true })
        .click()
      assert.equal(await input.locator('.fr-demo-translated').count(), 0)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(base + (en ? '/en/docs/' : '/docs/'))
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      await shot(page, locale + '-docs-mobile')
      await page.getByRole('button', { name: en ? 'Menu' : '目录', exact: true }).click()
      assert(await page.locator('.VPSidebar.open').isVisible())
      await page
        .getByRole('link', { name: en ? 'Input translation' : '输入框翻译', exact: true })
        .first()
        .click()
      await page.waitForURL('**/guide/input-translation')
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      report.cases.push(
        locale +
          ': documentation hub, local search, input demonstration, mobile sidebar navigation, 320/390/768/1024/1440 widths'
      )
      await page.goto(base + (locale === 'zh-CN' ? '/guide/support' : '/en/guide/support'))
      await page.waitForLoadState('networkidle')
      assert.equal(
        await page.locator('.support-visit').getAttribute('href'),
        'https://ko-fi.com/thinkstu'
      )
      assert.equal(await page.locator('.support-code img').evaluate((i) => i.naturalWidth), 1152)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      await shot(page, locale + '-support-mobile')
      await page.setViewportSize({ width: 1440, height: 960 })
      await shot(page, locale + '-support-desktop')
      await ctx.close()
    }
    report.cases.push(
      'Both browser locales: fixed homepage URL, explicit language routes, real HiDPI display, desktop/mobile layout, dark theme'
    )
    const ctx = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 960 },
    })
    const page = await ctx.newPage()
    attach(page)
    await page.goto(base + '/')
    await page.locator('.VPNavBarTranslations button').click()
    await page.locator('.VPNavBarTranslations a').filter({ hasText: 'English' }).click()
    await page.waitForURL('**/en/')
    await page.goto(base + '/')
    assert.equal(new URL(page.url()).pathname, '/')
    await page.goto(base + '/en/')
    await page.locator('.VPNavBarTranslations button').click()
    await page.locator('.VPNavBarTranslations a').filter({ hasText: '简体中文' }).click()
    await page.waitForURL(base + '/')
    await page.reload()
    assert.equal(new URL(page.url()).pathname, '/')
    await page.goto(base + '/guide/document-translation')
    await page.locator('.VPNavBarTranslations button').click()
    await page.locator('.VPNavBarTranslations a').filter({ hasText: 'English' }).click()
    await page.waitForURL('**/en/guide/document-translation')
    assert.match(await page.locator('h1').innerText(), /Document translation/)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.VPNavBarHamburger').click()
    await page.locator('.VPNavScreenTranslations button').click()
    await page.locator('.VPNavScreenTranslations a').click()
    await page.waitForURL('**/guide/document-translation')
    assert(!page.url().includes('/en/'))
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    await shot(page, 'guide-mobile-language-switch')
    await ctx.close()
    report.cases.push('Manual desktop/mobile switching and corresponding document routes')
    const legacyPreference = await browser.newContext({ locale: 'en-US' })
    await legacyPreference.addInitScript(() => {
      localStorage.setItem('fluentread-site-language', 'en')
    })
    const p = await legacyPreference.newPage()
    attach(p)
    await p.goto(base + '/')
    await p.waitForLoadState('networkidle')
    assert.equal(new URL(p.url()).pathname, '/')
    assert.equal(await p.locator('.product-tagline').innerText(), '让语言更近，让世界更大。')
    await legacyPreference.close()
    report.cases.push(
      'An English browser and a legacy English preference cannot redirect the submitted homepage'
    )
    const reduced = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 960 },
    })
    const reducedPage = await reduced.newPage()
    attach(reducedPage)
    await reducedPage.goto(base + '/')
    assert.equal(
      await reducedPage
        .locator('.fr-demo-translated')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'none'
    )
    await reduced.close()
    report.cases.push(
      'Reduced-motion preference disables demonstration animation while keeping all content readable'
    )
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
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  })
