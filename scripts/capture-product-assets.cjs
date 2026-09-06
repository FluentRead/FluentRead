#!/usr/bin/env node
// 官网与商店素材：真实生产扩展 + 自有演示文章 + 预先审校的本地译文，不请求商业服务。
// 保留 2x PNG 原图，再以独立脚本无损编码；不改写扩展 DOM 或伪造界面。
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const root = path.resolve(__dirname, '..')
const runtime = createRequire(
  path.join(arg('runtime', process.env.PLAYWRIGHT_ROOT), 'asset-capture.cjs')
)
const { chromium } = runtime('playwright')
const helper = require(arg('helper'))
const out = path.resolve(
  arg('output', path.join(root, 'marketing/source/screenshots'))
)
const english = arg('locale', 'zh-CN') === 'en'
const exampleModel = english ? 'Reading demo' : '阅读示例'
const readingOnly = process.argv.includes('--reading-only')
const pairs = [
  ['A little curiosity goes a long way.', '一点好奇心，就能带你走很远。'],
  [
    'There is something lovely about getting lost in a new subject. One question leads to another, and suddenly you are reading about a world you barely knew existed.',
    '钻进一个陌生的话题，是件很有意思的事。一个问题牵出另一个问题，不知不觉，你已经在读一个从前几乎不了解的世界。',
  ],
  ['Follow the interesting bits.', '沿着有意思的地方读下去。'],
  [
    'You do not have to understand every word to enjoy a good story. Start with the part that catches your eye. The details will make more sense as you keep reading.',
    '读一个好故事，不必一开始就弄懂每个词。从吸引你的那一段开始，读下去，细节自然会慢慢清楚。',
  ],
  ['A small habit, a bigger world.', '一个小习惯，一个更大的世界。'],
  [
    'Save a phrase that makes you smile. Look up a place you have never visited. Read one more paragraph. Small moments of curiosity can become the best part of your day.',
    '留下一句让你会心一笑的表达，查查一个还没去过的地方，再多读一段。日常这些小小的好奇，可能就是一天里最有意思的部分。',
  ],
  ['Make room for a second look.', '给自己一次细看的机会。'],
  [
    'Some ideas deserve a little more time. Read the original again, try the expression in your own words, and see what you notice the second time around.',
    '有些想法值得多花一点时间。再读一遍原文，试着用自己的话说一说，看看第二次会发现什么。',
  ],
]
let article = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A little curiosity — Field Notes</title><style>*{box-sizing:border-box}body{margin:0;color:#243044;background:#f7f9fc;font-family:Arial,'PingFang SC',sans-serif}header{height:76px;border-bottom:1px solid #e2e7ef;background:white;padding:0 92px;display:flex;align-items:center;justify-content:space-between}header strong{font-size:20px;letter-spacing:-.5px}header span{font-size:14px;color:#68758a}main{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:minmax(0,780px) 180px;gap:64px;padding:44px 18px}article{min-width:0}h1{font-size:36px;line-height:1.25;letter-spacing:-1px;margin:0 0 22px;font-weight:700}h2{font-size:24px;line-height:1.45;margin:30px 0 12px}article p{font-size:20px;line-height:1.7;margin:0 0 20px}aside{border-left:1px solid #dce2eb;padding-left:24px;margin-top:6px;font-size:14px;color:#6c7889;line-height:1.9}aside strong{display:block;color:#273348;margin-bottom:18px}aside span{display:block;margin-bottom:10px}.eyebrow{font-size:12px;letter-spacing:2px;color:#b9315b;margin-bottom:18px;font-weight:bold}</style></head><body><header translate="no"><strong>Field Notes <span> / Curious things, everyday.</span></strong><span>Stories &nbsp;&nbsp; Places &nbsp;&nbsp; Ideas</span></header><main><article><div class="eyebrow" translate="no">A FEW MINUTES OF CURIOSITY</div><h1>${pairs[0][0]}</h1><p id="selection">${pairs[1][0]}</p><h2>${pairs[2][0]}</h2><p>${pairs[3][0]}</p><h2>${pairs[4][0]}</h2><p>${pairs[5][0]}</p><h2>${pairs[6][0]}</h2><p>${pairs[7][0]}</p></article><aside translate="no"><strong>IN THIS STORY</strong><span>01 &nbsp; Get curious</span><span>02 &nbsp; Follow a question</span><span>03 &nbsp; Keep a phrase</span><br>FluentRead demo<br>Original sample article</aside></main></body></html>`
if (english) {
  for (const [en, zh] of pairs) article = article.replace(en, zh)
  article = article.replace('<html lang="en">', '<html lang="zh-Hans">')
}
const documentSample = `<!doctype html><html lang="${
  english ? 'zh-Hans' : 'en'
}"><meta charset="utf-8"><title>A little curiosity</title><style>body{max-width:750px;margin:36px auto;padding:0 28px;font-family:Arial,'PingFang SC',sans-serif;color:#243044}h1{font-size:28px;line-height:1.4}h2{font-size:22px;margin-top:30px}p{font-size:18px;line-height:1.8}</style><body>${pairs
  .map(([en, zh], i) => {
    const tag = i === 0 ? 'h1' : i % 2 === 0 ? 'h2' : 'p'
    return `<${tag}>${english ? zh : en}</${tag}>`
  })
  .join('')}</body></html>`
const translations = new Map(
  english ? pairs.map(([en, zh]) => [zh, en]) : pairs
)
const readingAnswer = english
  ? '### The idea\n**A little curiosity can lead to big discoveries.** The tone is warm and encouraging.\n\n### Keep this expression\n**一点……就……** connects a small start with a bigger result.\n\n一点耐心，就能发现更多。\nA little patience can help you discover more.'
  : '### 这句话的意思\n**一点好奇心，也能带来很大收获。** 语气轻松，带着鼓励。\n\n### 记住这个表达\n**go a long way**：很有帮助、能产生很大作用。\n\nA little patience goes a long way.\n多一点耐心，往往会很有帮助。'
let readingRequests = 0
let requests = 0
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'POST') {
    try {
      let body = ''
      for await (const c of req) body += c
      const data = JSON.parse(body)
      if (req.url === '/v1/chat/completions') {
        readingRequests++
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        const send = (delta, finish_reason = null) =>
          res.write(
            `data: ${JSON.stringify({
              id: 'product-reading-example',
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`
          )
        if (
          data.tools?.length &&
          !data.messages?.some((m) => m.role === 'tool')
        ) {
          send({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'product-read-context',
                type: 'function',
                function: { name: 'read_context', arguments: '{}' },
              },
            ],
          })
          send({}, 'tool_calls')
        } else {
          send({ role: 'assistant', content: readingAnswer })
          send({}, 'stop')
        }
        res.end('data: [DONE]\n\n')
        return
      }
      requests++
      const texts = Array.isArray(data) ? data : []
      const result = texts.map((text) => ({
        translations: [
          { text: translations.get(String(text).trim()) || String(text) },
        ],
      }))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    } catch (e) {
      res.writeHead(400)
      res.end(e.message)
    }
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(article)
})
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(
    path.join(out, english ? '../article-en.html' : '../article.html'),
    article
  )
  fs.writeFileSync(
    path.join(out, '../reading-answer-' + (english ? 'en' : 'zh-CN') + '.md'),
    readingAnswer + '\n'
  )
  fs.writeFileSync(
    path.join(
      out,
      english ? '../translations-en.json' : '../translations.json'
    ),
    JSON.stringify(Object.fromEntries(translations), null, 2) + '\n'
  )
  fs.writeFileSync(
    path.join(out, '../document-' + (english ? 'en' : 'zh-CN') + '.html'),
    documentSample
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fluentread-product-capture-')
  )
  let launched
  const report = {
    baseCommit: require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      })
      .trim(),
    extension: 'production chrome-mv3',
    captureScale: 2,
    content:
      'Self-authored sample; reviewed fixture translations through the real extension pipeline',
    screenshots: [],
    pageErrors: [],
  }
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
    const ctx = launched.context
    const worker =
      ctx.serviceWorkers()[0] ||
      (await ctx.waitForEvent('serviceworker', { timeout: 30000 }))
    const origin = worker.url().split('/').slice(0, 3).join('/')
    await worker.evaluate(
      ({ base }) => {
        const original = globalThis.fetch.bind(globalThis)
        globalThis.fetch = (input, init) => {
          const url =
            typeof input === 'string' ? input : input.url || String(input)
          if (
            url.startsWith('https://edge.microsoft.com/translate/translatetext')
          )
            return original(base + '/translate', init)
          return original(input, init)
        }
      },
      { base }
    )
    const create = async () => {
      const p = await helper.newPageWithoutForeground(ctx, 30000)
      p.setDefaultTimeout(30000)
      p.on('pageerror', (e) => report.pageErrors.push(e.message))
      return p
    }
    const popup = await create()
    await popup.goto(origin + '/popup.html')
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor()
    const patch = async (changes) => {
      const result = await popup.evaluate(async (changes) => {
        const r = await chrome.runtime.sendMessage({
          type: 'configStorageRead',
          key: 'local:config',
        })
        if (!r.success) throw Error(r.error)
        const old = typeof r.value === 'string' ? JSON.parse(r.value) : r.value
        return chrome.runtime.sendMessage({
          type: 'persistConfig',
          mode: 'replace',
          baseRevision: old.__fluentConfigRevision,
          clientId: 'product-capture-' + crypto.randomUUID(),
          sequence: 1,
          config: { ...old, ...changes },
        })
      }, changes)
      assert.equal(result.success, true, result.error)
    }
    await patch({
      uiLanguage: english ? 'en-US' : 'zh-CN',
      uiLanguageSetupCompleted: true,
      from: 'auto',
      to: english ? 'en' : 'zh-Hans',
      service: 'freeTranslation',
      fullPageTranslationMode: 'all',
      selectionTranslatorMode: 'bilingual',
      selectionTranslatorTrigger: 'direct',
      enableAIContext: false,
      enableAIMultiSegment: false,
    })
    const captures = new WeakMap()
    const scale = async (p, w = 1280, h = 800) => {
      await p.setViewportSize({ width: w, height: h })
      const c = await ctx.newCDPSession(p)
      captures.set(p, { c, w, h })
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 2,
        mobile: false,
      })
      return c
    }
    const shot = async (p, name, options = {}) => {
      await p.evaluate(() => document.fonts.ready)
      const { c, w, h } = captures.get(p)
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 2,
        mobile: false,
      })
      const clip = options.clip || { x: 0, y: 0, width: w, height: h }
      await new Promise((resolve) => setTimeout(resolve, 500))
      const data = await c.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...clip, scale: 1 },
      })
      const buffer = Buffer.from(data.data, 'base64')
      const width = buffer.readUInt32BE(16),
        height = buffer.readUInt32BE(20)
      assert.equal(
        width,
        clip.width * 2,
        'Export must retain actual 2x device pixels'
      )
      assert.equal(
        height,
        clip.height * 2,
        'Export must retain actual 2x device pixels'
      )
      fs.writeFileSync(path.join(out, name + '.png'), buffer)
      report.screenshots.push({ name, width, height })
      console.log('captured', name, width, height)
    }
    const page = await create()
    await page.goto(base + '/reading')
    await page
      .locator('#fluent-read-selection-translator-container')
      .waitFor({ state: 'attached' })
    await scale(page)
    await helper.activateExtensionTabWithoutForeground(ctx, page, 30000)
    if (!readingOnly) {
      await page.keyboard.press('Alt+t')
      await page.waitForFunction(
        () =>
          document.querySelectorAll('article .fluent-read-bilingual-content')
            .length >= 8
      )
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('一点好奇心') &&
          document.body.innerText.includes('A little curiosity')
      )
      await page.evaluate(() => scrollTo(0, 0))
      await shot(page, 'translation')
      await page.keyboard.press('Alt+t')
      await page.waitForFunction(
        () =>
          document.querySelectorAll('article .fluent-read-bilingual-content')
            .length === 0
      )
      await page.evaluate(() => scrollTo(0, 0))
      // Use actual pointer selection; the extension creates the card itself.
      const box = await page.locator('#selection').boundingBox()
      await page.mouse.move(box.x + 2, box.y + 12)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 2, box.y + box.height - 6, {
        steps: 20,
      })
      await page.mouse.up()
      await new Promise((r) => setTimeout(r, 1800))
      await shot(page, 'selection')
      await shot(page, 'selection-detail', {
        clip: { x: 98, y: 208, width: 700, height: 480 },
      })
      await popup.reload()
      await popup.locator('.popup-shell[data-config-ready="true"]').waitFor()
      await scale(popup, 360, 560)
      await shot(popup, 'popup')
      const settings = await create()
      await settings.goto(origin + '/options.html')
      await settings.locator('.sidebar').waitFor()
      await scale(settings)
      await shot(settings, 'settings-general')
      console.log(
        'sections',
        await settings.locator('.sidebar [data-section]').evaluateAll((ns) =>
          ns.map((n) => ({
            id: n.getAttribute('data-section'),
            text: n.textContent.trim(),
          }))
        )
      )
      const serviceButton = settings.locator(
        '.sidebar [data-section="settings-services"]'
      )
      if (await serviceButton.count()) await serviceButton.click()
      else
        await settings
          .getByRole('button', { name: '翻译服务', exact: true })
          .first()
          .click()
      await settings.locator('.service-catalog').waitFor()
      await shot(settings, 'settings-services')
      const doc = await create()
      await doc.goto(origin + '/document.html')
      await doc.locator('.file-drop-zone').waitFor()
      await scale(doc)
      await doc.locator('input[type=file]').setInputFiles({
        name: 'A little curiosity.html',
        mimeType: 'text/html',
        buffer: Buffer.from(documentSample),
      })
      await doc
        .getByRole('button', {
          name: english ? 'Start translation' : '开始翻译',
          exact: true,
        })
        .click()
      await doc
        .locator('.document-status')
        .filter({ hasText: english ? 'Translation complete' : '翻译完成' })
        .waitFor()
      await shot(doc, 'document')
    }
    // Capture the real Harness reading card through its configured local AI provider.
    // Fixture answers are reviewed copy; the extension still runs its session/tool pipeline.
    await patch({
      service: 'openai',
      vocabularyBookEnabled: true,
      customOpenAIProviders: [
        {
          id: 'custom:product-example',
          name: english ? 'Reading demo' : '阅读示例',
          endpoint: base + '/v1/chat/completions',
          models: [exampleModel],
        },
      ],
      token: { 'custom:product-example': 'local-example-not-a-secret' },
      model: { 'custom:product-example': exampleModel },
      harness: {
        enabled: true,
        service: 'custom:product-example',
        model: exampleModel,
        contextMode: 'paragraph',
        explanationDepth: 'concise',
        learningLevel: 'intermediate',
      },
    })
    await new Promise((r) => setTimeout(r, 1500))
    for (const p of ctx.pages()) if (p !== page) await p.close()
    await page.reload()
    await page
      .locator('#fluent-read-selection-translator-container')
      .waitFor({ state: 'attached' })
    await helper.activateExtensionTabWithoutForeground(ctx, page, 30000)
    await scale(page)
    await new Promise((r) => setTimeout(r, 1000))
    const titleBox = await page.locator('article h1').boundingBox()
    await page.mouse.move(titleBox.x + 1, titleBox.y + 12)
    await page.mouse.down()
    await page.mouse.move(
      titleBox.x + titleBox.width - 1,
      titleBox.y + titleBox.height - 10,
      { steps: 20 }
    )
    await page.mouse.up()
    const c = captures.get(page).c
    const children = (n) => [...(n?.children || []), ...(n?.shadowRoots || [])]
    const attr = (n, key) => {
      const a = n.attributes || []
      const i = a.indexOf(key)
      return i < 0 ? '' : a[i + 1]
    }
    const find = (n, pred) =>
      pred(n)
        ? n
        : children(n)
            .map((x) => find(x, pred))
            .find(Boolean)
    const content = (n) =>
      n.nodeName === '#text' ? n.nodeValue : children(n).map(content).join('')
    const snapshot = async () =>
      (await c.send('DOM.getDocument', { depth: -1, pierce: true })).root
    const waitNode = async (pred) => {
      for (let i = 0; i < 100; i++) {
        const node = find(await snapshot(), pred)
        if (node) return node
        await new Promise((r) => setTimeout(r, 100))
      }
      throw Error('Reading card did not reach expected state')
    }
    const action = await waitNode(
      (n) =>
        n.nodeName === 'BUTTON' &&
        content(n).trim() === (english ? 'Understand' : '读懂')
    )
    const quad = (await c.send('DOM.getBoxModel', { nodeId: action.nodeId }))
      .model.content
    await page.mouse.click((quad[0] + quad[2]) / 2, (quad[1] + quad[5]) / 2)
    await waitNode(
      (n) =>
        attr(n, 'class').split(' ').includes('fr-reading-answer') &&
        content(n).includes(english ? 'A little patience' : '多一点耐心')
    )
    assert(
      readingRequests >= 2,
      'The reading card must complete its actual context-tool round'
    )
    await new Promise((r) => setTimeout(r, 1000))
    const finalCard = content(await snapshot())
    assert(
      !finalCard.includes('设置已更新') &&
        !finalCard.includes('Settings updated.') &&
        !finalCard.includes('已停止'),
      'Reading card must be complete without stale settings'
    )
    await shot(page, 'reading-card')
    await shot(page, 'reading-card-detail', {
      clip: { x: 104, y: 188, width: 420, height: 570 },
    })
    report.readingRequests = readingRequests
    report.requests = requests
    report.sourceLanguage = 'auto'
    report.ok = true
  } catch (e) {
    report.error = e.stack
    console.error(e)
    process.exitCode = 1
  } finally {
    fs.writeFileSync(
      path.join(
        out,
        english ? '../capture-report-en.json' : '../capture-report.json'
      ),
      JSON.stringify(report, null, 2) + '\n'
    )
    if (launched) await launched.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    fs.rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150,
    })
  }
})()
