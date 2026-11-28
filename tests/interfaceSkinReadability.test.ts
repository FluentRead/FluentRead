import {existsSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import {interfaceSkinOptions} from '@/src/core/config/interfaceAppearance'

const root = resolve(__dirname, '..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')
const craftSkins = interfaceSkinOptions.filter(skin => skin.kind === 'craft')
const baseCss = () => source('src/ui/styles/interface-skins/popup-skins-base.css')
const themesCss = () => source('src/ui/styles/interface-skins/popup-skins-themes.css')

type Rgb = [number, number, number]
type Tokens = Record<string, string>

function parseHex(value: string | undefined): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value?.trim() ?? '')
  if (!match) throw new Error(`期望 6 位十六进制颜色，实际为 ${String(value)}`)
  const number = Number.parseInt(match[1], 16)
  return [number >> 16 & 255, number >> 8 & 255, number & 255]
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255
    return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  })
  return .2126 * r + .7152 * g + .0722 * b
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + .05) / (darker + .05)
}

function declarations(css: string, selector: string): Tokens {
  const start = css.indexOf(selector)
  if (start < 0) return {}
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  return Object.fromEntries([...css.slice(open, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)]
    .map(match => [match[1], match[2].trim().replace(/\s+/g, ' ')]))
}

function extractHexStops(value: string): Rgb[] {
  const matches = value.match(/#[0-9a-f]{6}/gi) ?? []
  if (!matches.length) throw new Error(`无法解析颜色：${value}`)
  return matches.map(parseHex)
}

function expectContrast(text: string, surface: Rgb, minimum: number, label: string) {
  expect(contrast(parseHex(text), surface), `${label}（${text} 对 rgb(${surface.map(Math.round).join(', ')})）`).toBeGreaterThanOrEqual(minimum)
}

function skinModes(skin: typeof craftSkins[number]): Record<string, Tokens> {
  const css = themesCss()
  if (skin.toneMode === 'dark') {
    const dark = declarations(css, `:root[data-popup-root][data-interface-skin="${skin.value}"]`)
    expect(Object.keys(dark).length, `${skin.value} 缺少专属深色变量`).toBeGreaterThan(0)
    return {dark}
  }
  const light = declarations(css, `:root[data-popup-root]:not(.dark)[data-interface-skin="${skin.value}"]`)
  const dark = declarations(css, `:root.dark[data-popup-root][data-interface-skin="${skin.value}"]`)
  expect(Object.keys(light).length, `${skin.value} 缺少浅色变量`).toBeGreaterThan(0)
  expect(Object.keys(dark).length, `${skin.value} 缺少深色变量`).toBeGreaterThan(0)
  return {light, dark}
}

describe('Popup 专属皮肤可读性与隔离契约', () => {
  it('全部 15 套 craft 皮肤在亮/暗态下满足 WCAG 2.2 AA 可读性对比度', () => {
    for (const skin of craftSkins) {
      const textMin = 4.5
      const inkMin = 10.0
      for (const [mode, tokens] of Object.entries(skinModes(skin))) {
        const label = `${skin.value} ${mode}`
        const page = parseHex(tokens['--skin-page'])
        const surface = parseHex(tokens['--skin-surface'])
        const soft = parseHex(tokens['--skin-surface-soft'])
        const hover = parseHex(tokens['--skin-surface-hover'])
        const brandSoft = parseHex(tokens['--skin-brand-soft'])

        for (const [name, bg] of Object.entries({page, surface, soft, hover})) {
          expectContrast(tokens['--skin-ink'], bg, inkMin, `${label} ink on ${name}`)
          expectContrast(tokens['--skin-muted'], bg, textMin, `${label} muted on ${name}`)
        }
        expectContrast(tokens['--skin-brand'], surface, 3.0, `${label} brand on surface`)
        expectContrast(tokens['--skin-brand-strong'], surface, textMin, `${label} brand-strong on surface`)
        expectContrast(tokens['--skin-brand-strong'], soft, textMin, `${label} brand-strong on soft`)
        expectContrast(tokens['--skin-brand-strong'], brandSoft, textMin, `${label} brand-strong on brand-soft`)

        // 主按钮在静态与悬停态（含渐变起止色）均满足可读性要求
        for (const fillKey of ['--skin-action-bg', '--skin-action-hover'] as const) {
          for (const stop of extractHexStops(tokens[fillKey])) {
            expectContrast(tokens['--skin-action-text'], stop, textMin, `${label} action text on ${fillKey}`)
          }
        }
        // 开关开启态圆钮对比度（防止亮色轨道 + 白色圆钮隐身）
        expectContrast(tokens['--skin-switch-knob'], parseHex(tokens['--skin-switch-on-bg']), textMin, `${label} switch knob`)
      }
    }
  })

  it('皮肤样式严格限定于 Popup 与 .popup-skin-scope，绝不污染 Options 或 tokens.css', () => {
    const tokens = source('src/ui/styles/tokens.css')
    expect(tokens).not.toContain('data-interface-skin')

    const combined = `${source('src/ui/styles/interface-skins.css')}\n${baseCss()}\n${themesCss()}`
    for (const forbidden of [
      '.settings-app',
      '.settings-card',
      '.service-catalog',
      '.image-ocr-recommendation',
      '.vocabulary-book',
      '.about-hero',
      '--skin-workspace',
      '--skin-sidebar',
      '--skin-nav-active',
    ]) {
      expect(combined, forbidden).not.toContain(forbidden)
    }
    expect(combined).not.toMatch(/\.sidebar(?:\s|\{|,|\.)/u)

    // `.popup-skin-scope` 主题隔离防火墙同时提供 light/dark 重置与派生短别名重绑定
    const base = baseCss()
    expect(base).toContain('.popup-skin-scope[data-popup-theme="light"]')
    expect(base).toContain('.popup-skin-scope[data-popup-theme="dark"]')
    expect(base).toContain('.popup-skin-scope[data-popup-theme]')
    expect(base).toContain('--brand: var(--fr-color-brand);')

    // 专属深色皮肤声明了深色反馈变量
    for (const darkSkin of craftSkins.filter(skin => skin.toneMode === 'dark')) {
      expect(base).toContain(`data-interface-skin="${darkSkin.value}"`)
    }
  })

  it('15 套 craft 皮肤造型、圆角与色板互不重复，且保持品牌 Logo 原样与精简 CSS 体积', () => {
    const signatures = craftSkins.map((skin) => {
      const firstMode = Object.values(skinModes(skin))[0]
      return [
        skin.popupWidth,
        skin.toneMode,
        firstMode['--skin-page'],
        firstMode['--skin-action-bg'],
        firstMode['--skin-panel-radius'] ?? '12px',
        firstMode['--skin-icon-radius'] ?? '7px',
      ].join(' | ')
    })
    expect(craftSkins).toHaveLength(15)
    expect(new Set(signatures).size).toBe(15)

    // 品牌 Logo 在所有皮肤下不被滤镜或改色，且不挂载角落插画
    expect(existsSync(resolve(root, 'src/ui/components/InterfaceBackdrop.vue'))).toBe(false)
    expect(baseCss()).not.toMatch(/\.brand img|preview-logo/)
    expect(themesCss()).not.toMatch(/\.brand img|preview-logo/)
    for (const path of ['src/app/popup/PopupApp.vue', 'src/app/options/OptionsApp.vue', 'src/features/settings/ui/InterfaceSettings.vue']) {
      expect(source(path)).not.toContain('InterfaceBackdrop')
    }

    // 源码体积守卫：Popup 专属多材质视觉架构较旧版 224KB 缩减超过 60%
    const totalBytes = Buffer.byteLength(baseCss(), 'utf8') + Buffer.byteLength(themesCss(), 'utf8')
    expect(totalBytes).toBeLessThan(90_000)
  })
})
