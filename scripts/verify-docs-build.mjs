#!/usr/bin/env node
// Check the exact static artifact shipped to GitHub Pages, including legacy links.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'docs/.vitepress/dist')
const brandTaglines = JSON.parse(
  fs.readFileSync(path.join(root, 'src/core/i18n/messages/brand-taglines.json'), 'utf8')
)
const files = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const resolve = (href) => {
  const url = new URL(href, 'https://read.thinkstu.com')
  let name = decodeURIComponent(url.pathname)
  if (name.endsWith('/')) name += 'index.html'
  const exact = path.join(dist, name)
  return fs.existsSync(exact) && fs.statSync(exact).isFile()
    ? exact
    : fs.existsSync(exact + '.html')
    ? exact + '.html'
    : null
}
const docs = new Map(
  files(dist)
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f, parseHTML(fs.readFileSync(f, 'utf8')).document])
)
const report = { pages: docs.size, links: 0, anchors: 0, images: 0 }
for (const [file, doc] of docs) {
  assert(doc.querySelector('h1') || file.endsWith('/404.html'), `Missing page title: ${file}`)
  if (file.endsWith('/404.html')) {
    assert(doc.querySelector('meta[name="robots"]')?.getAttribute('content') === 'noindex')
    assert(
      !doc.querySelector('link[rel="alternate"]'),
      '404 must not advertise missing translations'
    )
  } else {
    const route = path.relative(dist, file)
    const alternatePath = (route.startsWith('en/') ? route.slice(3) : 'en/' + route)
      .replace(/index\.html$/, '')
      .replace(/\.html$/, '')
    assert.equal(
      doc.querySelector('.bv-language')?.getAttribute('href'),
      '/' + alternatePath,
      `Language switch must preserve the page without a language-specific hash: ${route}`
    )
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')
    assert(canonical?.startsWith('https://read.thinkstu.com/'), `Missing canonical: ${file}`)
    assert(resolve(canonical), `Missing canonical target: ${canonical}`)
    for (const alternate of doc.querySelectorAll('link[rel="alternate"][hreflang]')) {
      assert(resolve(alternate.getAttribute('href')), `Missing translated URL: ${file}`)
    }
  }
  for (const demo of doc.querySelectorAll('[data-visual],[data-demo]')) {
    assert(demo.querySelector('.ds'), `Animated walkthrough needs numbered workflow steps: ${file}`)
    const stages = demo.querySelectorAll('.ds li')
    const stageButtons = demo.querySelectorAll('.ds li > button')
    assert.equal(stageButtons.length, stages.length, `Every workflow stage must be clickable: ${file}`)
    for (const button of stageButtons) {
      assert.equal(button.getAttribute('type'), 'button')
      assert(button.getAttribute('aria-label'), `Step button needs an accessible action: ${file}`)
    }
    assert.equal(
      demo.querySelectorAll('.ds-current').length,
      1,
      `Walkthrough needs one current stage: ${file}`
    )
  }
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')
    if (!href.startsWith('/') && !href.startsWith('#')) continue
    if (href.startsWith('//')) continue
    const url = new URL(href, 'https://read.thinkstu.com/' + path.relative(dist, file))
    const target = resolve(url.href)
    assert(target, `Missing link ${href} in ${path.relative(dist, file)}`)
    report.links++
    if (url.hash && target.endsWith('.html')) {
      assert(
        docs.get(target)?.getElementById(decodeURIComponent(url.hash.slice(1))),
        `Missing anchor ${href} in ${path.relative(dist, file)}`
      )
      report.anchors++
    }
  }
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src')
    if (!src.startsWith('/')) continue
    assert(resolve(src), `Missing image ${src}`)
    if (img.closest('.vp-doc,.bv-site'))
      assert(
        img.hasAttribute('width') && img.hasAttribute('height'),
        `Image needs dimensions: ${src}`
      )
    report.images++
  }
}
for (const file of files(path.join(root, 'docs/guide'))
  .concat(files(path.join(root, 'docs/config')))
  .filter((f) => f.endsWith('.md'))) {
  assert(
    fs.existsSync(path.join(root, 'docs/en', path.relative(path.join(root, 'docs'), file))),
    `Missing English equivalent: ${file}`
  )
}
for (const prefix of ['', '/en']) {
  const home = docs.get(resolve(prefix + '/'))
  assert(
    home.querySelector('.bv-home-brand img[src="/brand-icon.webp"]'),
    'Primary brand icon missing'
  )
  assert(
    !home.querySelector('[data-visual="input"]') &&
      !home.querySelector('a[href$="/guide/input-translation"]'),
    'Input translation should not be marketed on the homepage'
  )
  assert(
    ['document', 'image', 'video', 'selection'].every((kind) =>
      home.querySelector(`[data-visual="${kind}"]`)
    ),
    'The five primary translation features must be present'
  )
  assert(
    ['YouTube', 'X', 'Google Meet', 'Teams', 'Zoom'].every((name) =>
      home.querySelector('.bv-video-platforms')?.textContent.includes(name)
    ),
    'Video and meeting platforms missing'
  )
  assert(!home.querySelector('.bv-hero [data-demo]'), 'Full demonstration belongs below the hero')
  assert(home.querySelector('.bv-home-header'), 'Homepage must use focused marketing navigation')
  assert(
    !home.querySelector('.bv-identity,.bv-platforms'),
    'Competing brand block and browser row must be removed'
  )
  assert(
    home.querySelector('.bv-translation-section [data-demo="brand-reader"]'),
    'Translation demo must appear below the hero'
  )
  assert(!home.querySelector('.bv-walkthrough'), 'Numbered walkthrough controls must be removed')
  assert.equal(home.querySelectorAll('.bv-hero h1').length, 1, 'Hero needs one primary headline')
  assert.equal(
    home.querySelectorAll('.bv-hero .bv-install-actions > a.bv-primary').length,
    1,
    'Hero needs one primary install action'
  )
  const docsAction = home.querySelector('.bv-hero .bv-docs-link')
  assert.equal(docsAction?.getAttribute('href'), `${prefix}/docs/`)
  assert.equal(docsAction?.textContent.trim(), prefix ? 'Documentation' : '使用文档')
  const workflows = [...home.querySelectorAll('.bv-feature-row .ds')]
  assert.equal(workflows.length, 5, 'Each feature demo needs a workflow')
  assert(
    workflows.every(
      (flow) =>
        flow.querySelectorAll('li').length === 3 &&
        flow.querySelectorAll('[aria-current="step"]').length === 1
    ),
    'Feature workflows need three stages and one current stage'
  )
  const docsBrand = docs.get(resolve(prefix + '/docs/')).querySelector('.VPNavBarTitle .title')
  assert(
    docsBrand?.textContent.includes('流畅阅读') && docsBrand.textContent.includes('FluentRead')
  )
  assert.equal(
    home.querySelectorAll('.bv-browser-options a').length,
    3,
    'Other browser installation options missing'
  )
  assert(
    [...home.querySelectorAll('[data-visual],[data-demo]')].every(
      (d) => d.getAttribute('data-playing') === 'true'
    ),
    'Homepage demonstrations must start automatically'
  )
  assert(
    home.querySelector('[data-demo="brand-reader"]') &&
      home.querySelector('.fd-sentence-card') &&
      home.querySelector('.fd-structure-card') &&
      home.querySelector('.fd-word-card'),
    'Homepage must contain readable SSR examples'
  )
  assert(
    home.querySelector(`a[href="${prefix}/docs/"]`),
    'Documentation must be reachable from the homepage'
  )
  const hub = docs.get(resolve(prefix + '/docs/'))
  assert(
    hub.querySelector('.fr-docs-start a') && hub.querySelectorAll('.fr-docs-links a').length >= 20,
    'Quick start and functional documentation directory missing'
  )
  assert(
    !hub.querySelector('.fr-docs-mini,.fr-docs-route'),
    'Documentation hub must focus on instructions and named guide links'
  )
  assert(
    home
      .querySelector('.bv-translation-section h2')
      ?.textContent.includes(prefix ? 'Bilingual' : '双语翻译'),
    'Primary feature needs a visible bilingual translation heading'
  )
  assert(
    home.querySelector('.bv-hero-intro > span')?.textContent.trim() ===
      (prefix
        ? 'FluentRead is an open-source browser extension for bilingual translation.'
        : '流畅阅读，一款开源的浏览器双语翻译插件') &&
      home.querySelector('.bv-hero h1.bv-hero-slogan')?.textContent.trim() ===
        (prefix ? brandTaglines['en-US'] : brandTaglines['zh-CN']),
    'Canonical slogan must be the headline, with the product name in the localized introduction'
  )
  assert(
    home.querySelector('.bv-home-brand')?.textContent.includes(prefix ? 'FluentRead' : '流畅阅读'),
    'Localized product name missing'
  )
  assert(
    home.querySelector('.bv-hero-orbit')?.textContent.includes('Hello') &&
      home.querySelector('.bv-hero-orbit')?.textContent.includes('你好'),
    'Multilingual greetings missing'
  )
  assert.equal(
    home.querySelectorAll('.bv-feature-row').length,
    5,
    'Five consistent feature sections required'
  )
  assert(
    ['page', 'document', 'grammar'].every((kind) =>
      home.querySelector(`.bv-hero-orbit .bv-orbit-${kind}`)
    ),
    'Hero scene decorations must stay present'
  )
  assert(
    home.querySelector(
      '.fd-selection button[aria-label="' +
        (prefix ? 'Preview reading the original' : '演示朗读原文') +
        '"]'
    ) &&
      home.querySelector(
        '.fd-selection button[aria-label="' +
          (prefix ? 'Preview reading the translation' : '演示朗读译文') +
          '"]'
      ),
    'Selection card needs original and translation read-aloud previews'
  )
  assert.equal(
    home.querySelectorAll('.bv-promo video,.bv-promo iframe').length,
    1,
    'Homepage carries one introduction video'
  )
  assert(
    !home.querySelector('.bv-hero video,.bv-hero iframe'),
    'Introduction video belongs below the hero'
  )
  if (prefix) {
    const promo = home.querySelector('.bv-promo video')
    assert(promo, 'English homepage introduction video missing')
    assert(
      promo.hasAttribute('controls') &&
        !promo.hasAttribute('autoplay') &&
        promo.getAttribute('preload') === 'none',
      'English introduction video must stay visitor-controlled and load only on play'
    )
    for (const src of [
      promo.getAttribute('poster'),
      promo.querySelector('source')?.getAttribute('src'),
    ])
      assert(
        src?.includes('fluentread-promo-en') && resolve(src),
        `Missing introduction video asset ${src}`
      )
  } else {
    const promo = home.querySelector('.bv-promo iframe')
    assert(promo, 'Chinese homepage Bilibili introduction video missing')
    const player = new URL(promo.getAttribute('src'))
    assert.equal(player.origin, 'https://player.bilibili.com')
    assert.equal(player.pathname, '/player.html')
    assert.equal(player.searchParams.get('bvid'), 'BV1VLHE6hEnB')
    assert.equal(player.searchParams.get('autoplay'), '0')
    assert.equal(player.searchParams.get('danmaku'), '0')
    assert.equal(promo.getAttribute('loading'), 'lazy')
    assert(promo.getAttribute('title'), 'Embedded video needs an accessible title')
    assert(promo.hasAttribute('allowfullscreen'), 'Embedded video must support fullscreen')
    const fallback = home.querySelector('.bv-promo-link')
    assert.equal(fallback?.getAttribute('href'), 'https://www.bilibili.com/video/BV1VLHE6hEnB/')
    assert.equal(fallback?.getAttribute('target'), '_blank')
    assert(fallback?.getAttribute('rel')?.includes('noopener'))
    assert(!home.querySelector('video'), 'Chinese homepage must use the Bilibili player')
  }
  assert(
    !home.querySelector('.bv-pointer,.bv-end'),
    'Confusing cursor paths and repeated installation section must be removed'
  )
  assert(
    !home.querySelector('.bv-hero')?.textContent.includes('AI'),
    'Hero should foreground translation, without AI marketing'
  )
  assert(
    docs
      .get(resolve(prefix + '/config/translation-engines'))
      .querySelector('.vp-doc')
      .textContent.includes('{{apiKey}}'),
    'Provider placeholders must remain readable literal text'
  )
  const input = docs
    .get(resolve(prefix + '/guide/input-translation'))
    .querySelector('.vp-doc').textContent
  assert(input.includes('{{origin}}') && input.includes('{{to}}'), 'Prompt placeholders missing')
}
assert(
  !fs.existsSync(path.join(dist, 'maintainers')) && !fs.existsSync(path.join(dist, 'reports')),
  'Internal reports must stay out of the public website'
)
assert(fs.existsSync(path.join(dist, 'sitemap.xml')), 'Missing sitemap')
console.log(JSON.stringify({ ok: true, ...report }))
