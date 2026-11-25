import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const read = (relPath: string) => readFileSync(resolve(root, relPath), 'utf8')

type Rgb = [number, number, number]

function parseHex(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (!match) throw new Error(`Expected 6-digit hex color, got: ${value}`)
  const n = Number.parseInt(match[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: Rgb): number {
  const toLin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function blockTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start < 0) return {}
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  return Object.fromEntries(
    [...css.slice(open, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  )
}

describe('FluentRead Design System tokens & editorial guardrails', () => {
  const tokensCss = read('src/ui/styles/tokens.css')
  const light = blockTokens(tokensCss, ':root {\n  /* 品牌与核心操作色')
  const dark = blockTokens(tokensCss, ':root.dark {\n  --fr-color-brand:')
  const feedbackLight = blockTokens(tokensCss, ':root {\n  --fr-success:')
  const feedbackDark = blockTokens(tokensCss, ':root.dark,\n:root[data-interface-skin="xuanqing"]')

  it('declares complete semantic token scales for spacing, radius, typography, elevation, and motion', () => {
    for (const token of [
      '--fr-color-brand',
      '--fr-color-brand-action',
      '--fr-color-brand-strong',
      '--fr-color-canvas',
      '--fr-color-surface',
      '--fr-color-surface-soft',
      '--fr-color-ink',
      '--fr-color-muted',
      '--fr-color-line',
      '--fr-space-1',
      '--fr-space-4',
      '--fr-space-8',
      '--fr-radius-xs',
      '--fr-radius-sm',
      '--fr-radius-md',
      '--fr-radius-lg',
      '--fr-radius-full',
      '--fr-text-xs',
      '--fr-text-sm',
      '--fr-text-base',
      '--fr-text-md',
      '--fr-text-lg',
      '--fr-text-xl',
      '--fr-text-2xl',
      '--fr-shadow-xs',
      '--fr-shadow-md',
      '--fr-shadow-lg',
      '--fr-ease-out',
      '--fr-ease-in-out',
      '--fr-duration-instant',
      '--fr-duration-fast',
      '--fr-duration-normal',
      '--fr-focus-ring',
    ]) {
      expect(light[token], `missing light token ${token}`).toBeTruthy()
    }
    for (const token of [
      '--fr-color-canvas',
      '--fr-color-surface',
      '--fr-color-surface-soft',
      '--fr-color-ink',
      '--fr-color-muted',
      '--fr-color-line',
      '--fr-color-brand-action',
      '--fr-color-brand-strong',
    ]) {
      expect(dark[token], `missing dark token ${token}`).toBeTruthy()
    }
  })

  it('meets WCAG 2.2 AA contrast ratios across default light and dark themes', () => {
    // Light theme
    expect(contrast(light['--fr-color-ink'], light['--fr-color-surface'])).toBeGreaterThanOrEqual(10)
    expect(contrast(light['--fr-color-muted'], light['--fr-color-surface'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['--fr-color-muted'], light['--fr-color-surface-soft'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['--fr-color-brand-strong'], light['--fr-color-surface'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['--fr-color-brand-strong'], light['--fr-color-brand-soft'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', light['--fr-color-brand-action'])).toBeGreaterThanOrEqual(4.5)

    // Dark theme
    expect(contrast(dark['--fr-color-ink'], dark['--fr-color-surface'])).toBeGreaterThanOrEqual(10)
    expect(contrast(dark['--fr-color-muted'], dark['--fr-color-surface'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(dark['--fr-color-muted'], dark['--fr-color-surface-soft'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(dark['--fr-color-brand-strong'], dark['--fr-color-surface'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', dark['--fr-color-brand-action'])).toBeGreaterThanOrEqual(4.5)

    // Feedback colors
    for (const kind of ['success', 'warning', 'danger', 'info']) {
      expect(contrast(feedbackLight[`--fr-${kind}`], light['--fr-color-surface'])).toBeGreaterThanOrEqual(4.5)
      expect(contrast(feedbackLight[`--fr-${kind}`], feedbackLight[`--fr-${kind}-soft`])).toBeGreaterThanOrEqual(4.5)
      expect(contrast(feedbackDark[`--fr-${kind}`], dark['--fr-color-surface'])).toBeGreaterThanOrEqual(4.5)
      expect(contrast(feedbackDark[`--fr-${kind}`], feedbackDark[`--fr-${kind}-soft`])).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('removes decorative gradients and colored logo halo shadows from primary app surfaces', () => {
    const popupCss = read('src/app/popup/popup.css')
    const settingsCss = read('src/features/settings/ui/settings-page.css')
    const docCss = read('src/app/document-translation/document-page.css')
    const selectionTranslator = read('src/features/selection-translation/ui/SelectionTranslator.vue')
    const popupPreview = read('src/features/settings/ui/components/PopupPreview.vue')
    const floatingBall = read('src/features/floating-ball/ui/FloatingBall.vue')
    const progressPanel = read('src/features/full-page-translation/ui/TranslationProgressPanel.vue')

    expect(popupCss).not.toContain('linear-gradient(135deg, #f35482')
    expect(popupCss).not.toContain('radial-gradient(circle at 92% 0')
    expect(popupCss).not.toContain('box-shadow: 0 8px 18px rgba(239, 71, 118')
    expect(settingsCss).not.toContain('radial-gradient(ellipse at top left')
    expect(docCss).not.toContain('radial-gradient(circle at 91% 0')
    expect(selectionTranslator).not.toContain('linear-gradient(135deg, #f35482')
    expect(popupPreview).not.toContain('radial-gradient(')
    expect(floatingBall).toContain('--fr-surface: #171b24;')
    expect(progressPanel).toContain('rgba(23, 27, 36, 0.86)')
  })

  it('ships PRODUCT.md, DESIGN.md, and the .agents/skills/fluentread-ui skill bundle', () => {
    for (const relPath of [
      'PRODUCT.md',
      'DESIGN.md',
      '.agents/skills/fluentread-ui/SKILL.md',
      '.agents/skills/fluentread-ui/references/design-principles.md',
      '.agents/skills/fluentread-ui/references/component-guidelines.md',
      '.agents/skills/fluentread-ui/references/typography.md',
      '.agents/skills/fluentread-ui/references/interaction.md',
      '.agents/skills/fluentread-ui/references/accessibility.md',
      '.agents/skills/fluentread-ui/examples/settings-section-example.vue',
      '.agents/skills/fluentread-ui/examples/popup-drawer-example.vue',
    ]) {
      expect(existsSync(resolve(root, relPath)), `missing ${relPath}`).toBe(true)
    }
  })
})
