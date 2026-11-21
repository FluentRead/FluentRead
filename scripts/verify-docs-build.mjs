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
const landingLocales = Object.values(JSON.parse(
  fs.readFileSync(path.join(root, 'docs/.vitepress/landing-locales.json'), 'utf8')
))
const landingByFile = new Map(landingLocales.map(locale => [
  locale.path.slice(1) + 'index.html', locale,
]))
const website = 'https://read.thinkstu.com'
assert.deepEqual(landingLocales.map(locale => locale.assetLocale).sort(), Object.keys(brandTaglines).sort(),
  'The website landings must cover each published brand language')
const distReal = fs.realpathSync(dist)
const isArtifactFile = (file) => {
  const inside = (base, target) => {
    const relative = path.relative(base, target)
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }
  if (!inside(dist, file)) return false
  try {
    return fs.statSync(file).isFile() && inside(distReal, fs.realpathSync(file))
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}
const files = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const resolvedPaths = new Map()
const resolve = (href) => {
  let name
  try {
    const url = new URL(href, 'https://read.thinkstu.com')
    if (url.origin !== 'https://read.thinkstu.com') return null
    name = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (name.includes('\0')) return null
  if (name.endsWith('/')) name += 'index.html'
  if (resolvedPaths.has(name)) return resolvedPaths.get(name)
  const exact = path.join(dist, name)
  const target = isArtifactFile(exact)
    ? exact
    : isArtifactFile(exact + '.html')
    ? exact + '.html'
    : null
  resolvedPaths.set(name, target)
  return target
}
const docs = new Map(
  files(dist)
    // Storybook has its own HTML shell and artifact checker, not VitePress page metadata.
    .filter((f) => f.endsWith('.html') && !path.relative(dist, f).startsWith('storybook/'))
    .map((f) => {
      assert(isArtifactFile(f), `HTML must belong to the shipped artifact: ${f}`)
      return [f, parseHTML(fs.readFileSync(f, 'utf8')).document]
    })
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
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')
    assert(canonical?.startsWith('https://read.thinkstu.com/'), `Missing canonical: ${file}`)
    assert(resolve(canonical), `Missing canonical target: ${canonical}`)
    const alternates = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')]
    const landing = landingByFile.get(route)
    if (landing) {
      const languageLinks = [...doc.querySelectorAll('.bv-home-language a[hreflang]')]
      assert.equal(doc.documentElement.lang, landing.lang, `Wrong document language: ${route}`)
      assert.equal(canonical, website + landing.path)
      assert.deepEqual(
        languageLinks.map(link => [link.getAttribute('hreflang'), link.getAttribute('href')]),
        landingLocales.map(locale => [locale.lang, locale.path]),
        `Every localized landing must be reachable: ${route}`
      )
      assert.equal(doc.querySelector('.bv-home-language [aria-current="page"]')?.getAttribute('href'), landing.path)
      assert.deepEqual(
        alternates.map(link => [link.getAttribute('hreflang'), link.getAttribute('href')]),
        [...landingLocales.map(locale => [locale.lang, website + locale.path]),
          ['x-default', website + '/en/']],
        `Missing reciprocal language metadata: ${route}`
      )
      const shareImage = `${website}/brand/share/${landing.assetLocale}.jpg`
      const metadata = {
        'og:locale': landing.socialLocale,
        'og:title': landing.title,
        'og:description': landing.description,
        'og:image': shareImage,
        'og:image:alt': landing.imageAlt,
      }
      for (const [property, content] of Object.entries(metadata)) {
        assert.equal(doc.querySelector(`meta[property="${property}"]`)?.getAttribute('content'), content,
          `Missing localized share metadata: ${property} in ${route}`)
      }
      assert.equal(doc.querySelector('title')?.textContent, landing.title)
      assert.equal(doc.querySelector('meta[name="description"]')?.getAttribute('content'), landing.description)
      assert(resolve(shareImage), `Missing share artwork: ${shareImage}`)
      const reader = doc.querySelector('.fr-marketing-hero .fr-sample-reader')
      assert(reader && reader.getAttribute('data-view') === 'bilingual', `Missing bilingual sample: ${route}`)
      assert.equal(reader.querySelectorAll('.fr-reader-switch button').length, 2)
      assert.equal(reader.querySelectorAll('.fr-reader-switch button[aria-pressed="true"]').length, 1)
      assert.equal(reader.querySelectorAll('.fr-source[lang] + .fr-translation').length, 2)
      if (landing.lang !== 'zh-CN' && landing.lang !== 'en') {
        const installLinks = [...doc.querySelectorAll('.fr-install-actions a')].map(link => link.href)
        assert.equal(installLinks.length, 3, `Missing browser installs: ${route}`)
        assert(installLinks.some(url => new URL(url).hostname === 'chromewebstore.google.com'))
        assert(installLinks.some(url => new URL(url).hostname === 'microsoftedge.microsoft.com'))
        assert(installLinks.some(url => new URL(url).hostname === 'addons.mozilla.org'))
      }
    } else {
      const alternatePath = (route.startsWith('en/') ? route.slice(3) : 'en/' + route)
        .replace(/index\.html$/, '')
        .replace(/\.html$/, '')
      assert.equal(
        doc.querySelector('.bv-language')?.getAttribute('href'),
        '/' + alternatePath,
        `Language switch must preserve the page without a language-specific hash: ${route}`
      )
    }
    for (const alternate of alternates) {
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
    let url
    try {
      url = new URL(href, 'https://read.thinkstu.com/' + path.relative(dist, file))
    } catch {
      assert.fail(`Invalid link ${href} in ${path.relative(dist, file)}`)
    }
    if (url.origin !== 'https://read.thinkstu.com') continue
    const target = resolve(url.href)
    assert(target, `Missing link ${href} in ${path.relative(dist, file)}`)
    report.links++
    if (url.hash && target.endsWith('.html')) {
      let anchor
      try {
        anchor = decodeURIComponent(url.hash.slice(1))
      } catch {
        assert.fail(`Invalid anchor ${href} in ${path.relative(dist, file)}`)
      }
      assert(
        docs.get(target)?.getElementById(anchor),
        `Missing anchor ${href} in ${path.relative(dist, file)}`
      )
      report.anchors++
    }
  }
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src')
    if (!src.startsWith('/') || src.startsWith('//')) continue
    assert(resolve(src), `Missing image ${src}`)
    if (img.closest('.vp-doc,.bv-site'))
      assert(
        img.hasAttribute('width') && img.hasAttribute('height'),
        `Image needs dimensions: ${src}`
      )
    report.images++
  }
}
const sitemap = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8')
for (const locale of landingLocales) {
  assert(sitemap.includes(`<loc>${website + locale.path}</loc>`), `Landing missing from sitemap: ${locale.path}`)
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
  assert(!home.querySelector('.fr-marketing-hero [data-demo]'), 'Full demonstration belongs below the hero')
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
  assert.equal(home.querySelectorAll('.fr-marketing-hero h1').length, 1, 'Hero needs one primary headline')
  assert.equal(
    home.querySelectorAll('.fr-marketing-hero .bv-install-actions > a.bv-primary').length,
    1,
    'Hero needs one primary install action'
  )
  const docsAction = home.querySelector('.fr-marketing-hero .bv-docs-link')
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
  const productName = prefix ? 'FluentRead' : '流畅阅读'
  assert.equal(docsBrand?.querySelector('strong')?.textContent.trim(), productName)
  for (const page of [home, docs.get(resolve(prefix + '/docs/'))]) {
    assert.equal(page.querySelector('meta[property="og:site_name"]')?.getAttribute('content'), productName)
    assert(page.querySelector('title')?.textContent.includes(productName), 'Page title needs its locale product name')
  }
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
    home.querySelector('.fr-hero-copy > p')?.textContent.includes(prefix ? 'FluentRead' : '流畅阅读') &&
      home.querySelector('.fr-marketing-hero h1')?.textContent.trim() ===
        (prefix ? brandTaglines['en-US'] : brandTaglines['zh-CN']),
    'Canonical slogan must be the headline, with the product name in the localized introduction'
  )
  assert(
    home.querySelector('.bv-home-brand')?.textContent.includes(prefix ? 'FluentRead' : '流畅阅读'),
    'Localized product name missing'
  )
  assert.equal(
    home.querySelectorAll('.bv-feature-row').length,
    5,
    'Five consistent feature sections required'
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
    !home.querySelector('.fr-marketing-hero video,.fr-marketing-hero iframe'),
    'Introduction video belongs below the hero'
  )
  const promo = home.querySelector('.bv-promo video')
  assert(promo, 'Homepage must initially show the original introduction video')
  assert(
    promo.hasAttribute('controls') &&
      !promo.hasAttribute('autoplay') &&
      promo.getAttribute('preload') === 'none',
    'Introduction video must stay visitor-controlled and avoid loading before it is needed'
  )
  for (const src of [
    promo.getAttribute('poster'),
    promo.querySelector('source')?.getAttribute('src'),
  ])
    assert(
      src?.includes(`fluentread-promo-${prefix ? 'en' : 'zh'}`) && resolve(src),
      `Missing introduction video asset ${src}`
    )
  assert(!home.querySelector('.bv-promo iframe'), 'Bilibili must only load after the original fails')
  assert(!home.querySelector('.bv-promo-link'), 'Homepage should not repeat the short-video link')
  const officialIntroduction = home.querySelector('.bv-promo-more a')
  assert.equal(officialIntroduction?.getAttribute('href'), 'https://www.bilibili.com/video/BV1qhHJ6uEiF/')
  assert.equal(officialIntroduction?.getAttribute('target'), '_blank')
  assert(officialIntroduction?.getAttribute('rel')?.includes('noopener'))
  assert(
    !home.querySelector('.bv-pointer,.bv-end'),
    'Confusing cursor paths and repeated installation section must be removed'
  )
  assert(
    !home.querySelector('.fr-marketing-hero')?.textContent.includes('AI'),
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
