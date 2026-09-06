#!/usr/bin/env node
// 将中英文商店资料分别打包；保留高清原图与示例来源，不把发布压缩包复制到官网。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const JSZip = require('jszip')
const root = path.resolve(__dirname, '..')
const index = process.argv.indexOf('--output')
if (index < 0 || !process.argv[index + 1])
  throw Error('Pass --output <directory>')
const output = path.resolve(process.argv[index + 1])
const allFiles = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? allFiles(path.join(dir, e.name))
        : [path.join(dir, e.name)]
    )
;(async () => {
  fs.mkdirSync(output, { recursive: true })
  for (const locale of ['zh-CN', 'en']) {
    const zip = new JSZip()
    const folder = path.join(root, 'marketing/chrome-web-store', locale)
    for (const file of allFiles(folder))
      zip.file(path.relative(folder, file), fs.readFileSync(file))
    const instructions = fs
      .readFileSync(path.join(folder, 'README.md'), 'utf8')
      .replace('../promo/', './promo/')
      .replace(`../../copy/${locale}.md`, './community.md')
      .replace(
        `../../source/${locale === 'en' ? 'screenshots-en' : 'screenshots'}/`,
        './originals/'
      )
    zip.file('README.md', instructions)
    zip.file(
      'community.md',
      fs.readFileSync(path.join(root, 'marketing/copy', locale + '.md'))
    )
    const promo = path.join(root, 'marketing/chrome-web-store/promo')
    for (const file of allFiles(promo).filter((f) =>
      path.basename(f).startsWith(locale + '-')
    ))
      zip.file('promo/' + path.basename(file), fs.readFileSync(file))
    const originals = path.join(
      root,
      'marketing/source',
      locale === 'en' ? 'screenshots-en' : 'screenshots'
    )
    for (const file of allFiles(originals).filter((f) => f.endsWith('.png')))
      zip.file('originals/' + path.basename(file), fs.readFileSync(file))
    for (const [source, dest] of [
      ['marketing/chrome-web-store/icon-128.png', 'icon-128.png'],
      ['LICENSE', 'LICENSE'],
      [
        'public/third-party-notices/deepseek-harness-MIT.txt',
        'third-party-notices/deepseek-harness-MIT.txt',
      ],
      [
        `marketing/source/capture-report${locale === 'en' ? '-en' : ''}.json`,
        'source/capture-report.json',
      ],
      [
        `marketing/source/article${locale === 'en' ? '-en' : ''}.html`,
        'source/article.html',
      ],
      [
        `marketing/source/translations${locale === 'en' ? '-en' : ''}.json`,
        'source/translations.json',
      ],
      [
        `marketing/source/reading-answer-${locale}.md`,
        'source/reading-answer.md',
      ],
      [`marketing/source/document-${locale}.html`, 'source/document.html'],
    ])
      zip.file(dest, fs.readFileSync(path.join(root, source)))
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
    const reopened = await JSZip.loadAsync(buffer)
    const files = Object.values(reopened.files).filter((f) => !f.dir)
    assert.equal(
      files.filter((f) => f.name.startsWith('screenshots/')).length,
      5
    )
    assert.equal(files.filter((f) => f.name.startsWith('promo/')).length, 2)
    assert.equal(files.filter((f) => f.name.startsWith('originals/')).length, 9)
    assert(
      files.every((f) => !f.name.startsWith('/') && !f.name.includes('..'))
    )
    const file = path.join(output, `FluentRead-${locale}.zip`)
    fs.writeFileSync(file, buffer)
    console.log(
      JSON.stringify({
        locale,
        file,
        files: files.length,
        bytes: buffer.length,
      })
    )
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
