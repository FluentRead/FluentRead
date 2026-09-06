#!/usr/bin/env node
// 用真实 2x 截图生成像素无损 WebP、商店 RGB PNG 和纯排版宣传图，保留可复现来源。
const fs = require('node:fs'),
  path = require('node:path'),
  { createRequire } = require('node:module')
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i < 0 ? fallback : process.argv[i + 1]
}
const root = path.resolve(__dirname, '..')
const runtime = createRequire(
  path.join(arg('runtime', process.env.PLAYWRIGHT_ROOT), 'product-assets.cjs')
)
const sharp = runtime('sharp')
const { chromium } = runtime('playwright')
const entries = []
const record = async (file, source, kind) => {
  const m = await sharp(file).metadata()
  entries.push({
    file: path.relative(root, file),
    source: path.relative(root, source),
    kind,
    width: m.width,
    height: m.height,
    format: m.format,
    alpha: m.hasAlpha,
    bytes: fs.statSync(file).size,
  })
}
const mkdir = (p) => fs.mkdirSync(p, { recursive: true })
;(async () => {
  const names = [
    'translation',
    'selection',
    'selection-detail',
    'reading-card',
    'reading-card-detail',
    'popup',
    'settings-general',
    'settings-services',
    'document',
  ]
  for (const locale of ['zh-CN', 'en']) {
    const raw = path.join(
      root,
      'marketing/source',
      locale === 'en' ? 'screenshots-en' : 'screenshots'
    )
    const web = path.join(
      root,
      'docs/public/screenshots',
      locale === 'en' ? 'en' : ''
    )
    mkdir(web)
    const store = path.join(
      root,
      'marketing/chrome-web-store',
      locale,
      'screenshots'
    )
    mkdir(store)
    for (const old of [
      '02-selection.png',
      '03-document.png',
      '04-settings-general.png',
    ]) {
      const file = path.join(store, old)
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
    for (const name of names) {
      const source = path.join(raw, name + '.png'),
        dest = path.join(web, name + '.webp')
      await sharp(source).webp({ lossless: true, effort: 6 }).toFile(dest)
      await record(dest, source, 'web-lossless')
      const a = await sharp(source).removeAlpha().raw().toBuffer()
      const b = await sharp(dest).removeAlpha().raw().toBuffer()
      if (!a.equals(b)) throw Error('WebP pixels differ: ' + dest)
      if (name === 'translation') {
        const small = path.join(web, name + '-small.webp')
        await sharp(source)
          .resize({ width: 1280, withoutEnlargement: true })
          .webp({ lossless: true, effort: 6 })
          .toFile(small)
        await record(small, source, 'web-responsive')
      }
    }
    for (const [index, name] of [
      'translation',
      'reading-card',
      'selection',
      'document',
      'settings-services',
    ].entries()) {
      const source = path.join(raw, name + '.png'),
        dest = path.join(
          store,
          String(index + 1).padStart(2, '0') + '-' + name + '.png'
        )
      await sharp(source)
        .resize(1280, 800, { fit: 'inside', withoutEnlargement: true })
        .removeAlpha()
        .png({ compressionLevel: 9 })
        .toFile(dest)
      await record(dest, source, 'chrome-screenshot')
    }
  }
  // Preserve existing README image URLs for links from earlier releases.
  for (const name of [
    'translation',
    'popup',
    'settings-general',
    'settings-services',
  ])
    fs.copyFileSync(
      path.join(root, 'docs/public/screenshots', name + '.webp'),
      path.join(root, 'misc/screenshots', name + '.webp')
    )
  const logo = path.join(root, 'public/icon/512.png')
  const icon = path.join(root, 'marketing/chrome-web-store/icon-128.png')
  // The current icon already includes its own transparent surround. Preserve its approved artwork.
  await sharp(path.join(root, 'public/icon/128.png'))
    .png({ compressionLevel: 9 })
    .toFile(icon)
  await record(icon, path.join(root, 'public/icon/128.png'), 'chrome-icon')
  const promo = path.join(root, 'marketing/chrome-web-store/promo')
  mkdir(promo)
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  })
  try {
    for (const locale of ['zh-CN', 'en'])
      for (const [kind, width, height] of [
        ['small', 440, 280],
        ['marquee', 1400, 560],
      ]) {
        const en = locale === 'en'
        const logoData =
          'data:image/png;base64,' + fs.readFileSync(logo).toString('base64')
        const shotPath = path.join(
          root,
          'docs/public/screenshots',
          en ? 'en' : '',
          'reading-card-detail.webp'
        )
        const shot =
          'data:image/webp;base64,' +
          fs.readFileSync(shotPath).toString('base64')
        const html = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,'PingFang SC',sans-serif;color:white;background:#b92552;width:${width}px;height:${height}px;overflow:hidden}.canvas{height:100%;padding:${
          kind === 'small' ? '28px 32px' : '64px 72px'
        };display:flex;align-items:center;justify-content:space-between;gap:55px}.brand{display:flex;align-items:center;gap:12px;font-size:${
          kind === 'small' ? 20 : 25
        }px;font-weight:650}.brand img{width:${
          kind === 'small' ? 44 : 52
        }px;height:auto}h1{font-size:${
          kind === 'small' ? (en ? 35 : 44) : en ? 64 : 76
        }px;line-height:1.13;letter-spacing:-.04em;margin:${
          kind === 'small' ? '22px 0 0' : '30px 0 20px'
        };font-weight:750}p{font-size:17px;color:#ffe5ef;letter-spacing:.01em;line-height:1.6}.screen{width:auto;max-width:560px;max-height:430px;height:auto;border:6px solid #ffffff35;border-radius:14px;box-shadow:0 20px 55px #520f2840}</style><div class="canvas"><div><div class="brand"><img src="${logoData}" alt="">FluentRead</div><h1>${
          en ? 'Bilingual reading<br>and translation' : '双语阅读<br>与翻译'
        }</h1>${
          kind === 'marquee'
            ? `<p>${
                en
                  ? 'Open source · GPL-3.0<br>AI reading card with a browser adaptation of DeepSeek Harness.'
                  : 'GPL-3.0 开源项目<br>AI 翻译卡接入 DeepSeek Harness 会话内核的浏览器适配。'
              }</p>`
            : `<p>${
                en ? 'Open-source bilingual reading' : '开源双语阅读扩展'
              }</p>`
        }</div>${
          kind === 'marquee' ? `<img class="screen" src="${shot}" alt="">` : ''
        }</div></html>`
        const source = path.join(
          root,
          'marketing/source',
          `promo-${locale}-${kind}.html`
        )
        fs.writeFileSync(source, html)
        const page = await browser.newPage({
          viewport: { width, height },
          deviceScaleFactor: 1,
        })
        await page.setContent(html)
        await page.evaluate(() => document.fonts.ready)
        const buffer = await page.screenshot({ animations: 'disabled' })
        const dest = path.join(
          promo,
          `${locale}-${kind}-${width}x${height}.png`
        )
        await sharp(buffer)
          .removeAlpha()
          .png({ compressionLevel: 9 })
          .toFile(dest)
        await record(dest, source, 'chrome-promo')
        await page.close()
      }
  } finally {
    await browser.close()
  }
  for (const locale of ['zh-CN', 'en']) {
    const text = fs
      .readFileSync(
        path.join(
          root,
          'marketing/chrome-web-store',
          locale,
          'short-description.txt'
        ),
        'utf8'
      )
      .trim()
    if ([...text].length > 132) throw Error('Short description too long')
  }
  const rawBytes = entries
      .filter((x) => x.kind === 'web-lossless')
      .reduce((n, x) => n + fs.statSync(path.join(root, x.source)).size, 0),
    webBytes = entries
      .filter((x) => x.kind === 'web-lossless')
      .reduce((n, x) => n + x.bytes, 0)
  fs.writeFileSync(
    path.join(root, 'marketing/asset-manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        losslessWebPixelsVerified: true,
        rawBytes,
        webBytes,
        savingsPercent: Math.round((1 - webBytes / rawBytes) * 100),
        entries,
      },
      null,
      2
    ) + '\n'
  )
  console.log(
    JSON.stringify({
      assets: entries.length,
      rawBytes,
      webBytes,
      savingsPercent: Math.round((1 - webBytes / rawBytes) * 100),
    })
  )
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
