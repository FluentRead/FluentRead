import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERFACE_FONT,
  DEFAULT_INTERFACE_VISIBILITY,
  DEFAULT_POPUP_MODULE_ORDER,
  DEFAULT_POPUP_QUICK_FEATURE_ORDER,
  DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY,
  getInterfaceFontOption,
  getInterfaceSkinOption,
  interfaceFontOptions,
  interfaceSkinGroups,
  interfaceSkinOptions,
  interfaceSkinUsesContentHeight,
  interfaceVisibilityOptions,
  normalizeInterfaceFont,
  normalizeInterfaceSkin,
  normalizeInterfaceVisibility,
  normalizePopupModuleOrder,
  normalizePopupQuickFeatureOrder,
  normalizePopupQuickFeatureVisibility,
  popupModuleOptions,
  popupQuickFeatureOptions,
  withInterfaceVisibility,
  withPopupQuickFeatureVisibility,
} from '@/src/core/config/interfaceAppearance'
import { Config, normalizeConfig } from '@/src/core/config/model'
import { popupQuickFeatureIconPaths, popupQuickFeatureIconTones } from '@/src/ui/popupQuickFeatureIcons'

describe('Popup 皮肤与栏目配置', () => {
  it('默认保留当前界面并注册 4 大系列 16 套全新 Popup 皮肤', () => {
    const config = new Config()

    expect(config.interfaceSkin).toBe('default')
    expect(config.interfaceFont).toBe('system')
    expect(config.interfaceVisibility).toEqual(DEFAULT_INTERFACE_VISIBILITY)
    expect(config.popupModuleOrder).toEqual(DEFAULT_POPUP_MODULE_ORDER)
    expect(config.popupQuickFeatureOrder).toEqual(DEFAULT_POPUP_QUICK_FEATURE_ORDER)
    expect(config.popupQuickFeatureVisibility).toEqual(DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY)
    const expectedSkins = [
      'default',
      'liquid-glass',
      'aurora',
      'tactile',
      'brutalist',
      'cyber',
      'retro-os',
      'terminal',
      'editorial',
      'sakura',
      'matcha',
      'midnight-gold',
      'swiss-minimal',
      'golden-hour',
      'blueprint',
      'starlight',
    ]
    expect(interfaceSkinOptions.map((item) => item.value)).toEqual(expectedSkins)
    expect(interfaceSkinOptions.map((item) => item.label)).toEqual([
      '默认经典',
      '液态玻璃',
      '极光幻彩',
      '拟物硬件',
      '新粗野波普',
      '赛博霓虹',
      '经典复古桌面',
      '极客终端',
      '典藏画报',
      '樱雾物语',
      '宇治手账',
      '黑金典藏',
      '素净极简',
      '落日熔金',
      '建筑蓝图',
      '星穹漫游',
    ])
    expect(interfaceSkinGroups.map((item) => item.value)).toEqual(['atmosphere', 'expressive', 'editorial', 'horizon'])
    expect(interfaceSkinGroups.map((item) => item.label)).toEqual(['光影与材质', '潮流与个性', '东方与人文', '极简与视界'])
    for (const group of interfaceSkinGroups) {
      expect(interfaceSkinOptions.filter((item) => item.group === group.value)).toHaveLength(4)
    }
    expect(new Set(interfaceSkinOptions.map((item) => JSON.stringify(item.preview))).size).toBe(16)

    const hex = /^#[0-9a-f]{6}$/
    const fill = /^(#[0-9a-f]{6}|linear-gradient\(\d+deg(, #[0-9a-f]{6}( \d+%)?){2,3}\))$/
    for (const skin of interfaceSkinOptions) {
      expect(['default', 'craft']).toContain(skin.kind)
      expect(['adaptive', 'dark']).toContain(skin.toneMode)
      expect(skin.preview.cardStyle).toBe(skin.value)
      expect(skin.preview.panelRadius).toBeGreaterThanOrEqual(0)
      expect(skin.preview.panelRadius).toBeLessThanOrEqual(14)
      expect(skin.preview.controlRadius).toBeGreaterThanOrEqual(0)
      expect(skin.preview.controlRadius).toBeLessThanOrEqual(10)
      expect([0, 1, 2]).toContain(skin.preview.borderWidth)
      expect(['square', 'rounded', 'circle']).toContain(skin.preview.iconShape)
      for (const tone of [skin.preview.light, skin.preview.dark]) {
        for (const color of [tone.mat, tone.canvas, tone.surface, tone.surfaceSoft, tone.border, tone.ink, tone.muted, tone.accent, tone.actionInk, tone.iconBg, tone.iconFg, ...tone.swatches]) {
          expect(color).toMatch(hex)
        }
        expect(tone.actionBg).toMatch(fill)
      }
      if (skin.toneMode === 'dark') {
        expect(skin.preview.light).toEqual(skin.preview.dark)
      }
    }
    expect(interfaceSkinOptions.some(item => 'motif' in item)).toBe(false)
    expect(interfaceFontOptions.map((item) => item.value)).toEqual([
      'system',
      'inter',
      'noto-sans-sc',
      'roboto',
      'source-sans-3',
      'ibm-plex-sans',
      'manrope',
      'nunito-sans',
      'lxgw-wenkai',
      'noto-serif-sc',
    ])
    expect(interfaceFontOptions.every((item) => item.fontFamily.includes('sans-serif'))).toBe(true)
    expect(interfaceFontOptions.every((item) => item.labelKey.startsWith('settings.interface.font.'))).toBe(true)
    expect(normalizeConfig({interfaceSkin: 'liquid-glass'}).interfaceSkin).toBe('liquid-glass')
    expect(normalizeConfig({interfaceFont: 'noto-sans-sc'}).interfaceFont).toBe('noto-sans-sc')
    expect(interfaceSkinOptions.every((item) => interfaceSkinUsesContentHeight(item.value))).toBe(true)
    expect(getInterfaceSkinOption('default').popupWidth).toBe(320)
    expect(getInterfaceSkinOption('liquid-glass').popupWidth).toBe(324)
    expect(getInterfaceSkinOption('aurora').popupWidth).toBe(322)
    expect(getInterfaceSkinOption('retro-os').popupWidth).toBe(320)
    expect(getInterfaceSkinOption('swiss-minimal').popupWidth).toBe(312)
    expect(getInterfaceSkinOption('golden-hour').popupWidth).toBe(322)
    expect(getInterfaceSkinOption('blueprint').popupWidth).toBe(324)
    expect(getInterfaceSkinOption('starlight').popupWidth).toBe(326)
    expect(getInterfaceSkinOption('cyber').toneMode).toBe('dark')
    expect(getInterfaceSkinOption('terminal').toneMode).toBe('dark')
    expect(getInterfaceSkinOption('midnight-gold').toneMode).toBe('dark')
    expect(getInterfaceSkinOption('blueprint').toneMode).toBe('dark')
    expect(getInterfaceSkinOption('starlight').toneMode).toBe('dark')
    expect(interfaceVisibilityOptions.map((item) => item.key)).toEqual([
      'popupQuickFeatures',
      'popupSiteRule',
      'popupFooter',
    ])
    expect(popupModuleOptions.map((item) => item.id)).toEqual([
      'translation',
      'siteRule',
      'quickFeatures',
      'footer',
    ])
    expect(popupQuickFeatureOptions.map((item) => item.id)).toEqual([
      'hover',
      'selection',
      'appearance',
      'image',
      'document',
    ])
  })

  it('保留用户模块顺序，去重未知项并为旧布局补齐后来注册的模块', () => {
    expect(normalizePopupModuleOrder([
      'footer',
      'quickFeatures',
      'footer',
      'futureModule',
      'translation',
    ])).toEqual([
      'footer',
      'quickFeatures',
      'translation',
      'siteRule',
    ])
    expect(normalizePopupModuleOrder([])).toEqual(DEFAULT_POPUP_MODULE_ORDER)
    expect(normalizePopupModuleOrder('translation')).toEqual(DEFAULT_POPUP_MODULE_ORDER)
  })

  it('以新对象更新栏目显隐，避免共享引用让保存层误判为没有变化', () => {
    const sharedVisibility = {...DEFAULT_INTERFACE_VISIBILITY}
    const updated = withInterfaceVisibility(sharedVisibility, 'popupQuickFeatures', false)

    expect(updated).not.toBe(sharedVisibility)
    expect(sharedVisibility.popupQuickFeatures).toBe(true)
    expect(updated.popupQuickFeatures).toBe(false)
  })

  it('独立归一化快捷卡片的顺序和显隐，并以新对象更新单张卡片', () => {
    expect(normalizePopupQuickFeatureOrder([
      'document',
      'hover',
      'document',
      'futureFeature',
    ])).toEqual([
      'document',
      'hover',
      'selection',
      'appearance',
      'image',
    ])
    expect(normalizePopupQuickFeatureOrder(null)).toEqual(DEFAULT_POPUP_QUICK_FEATURE_ORDER)

    const sharedVisibility = {...DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY}
    const updated = withPopupQuickFeatureVisibility(sharedVisibility, 'image', false)
    expect(updated).not.toBe(sharedVisibility)
    expect(sharedVisibility.image).toBe(true)
    expect(updated.image).toBe(false)
    expect(normalizePopupQuickFeatureVisibility({hover: false, image: 'false'})).toEqual({
      hover: false,
      selection: true,
      appearance: false,
      image: true,
      document: true,
    })
  })

  it('合并旧圈选入口时保留排序、可见性和独立功能偏好', () => {
    const migrated = normalizeConfig({popupQuickFeatureOrder: ['area', 'image', 'video', 'hover'], popupQuickFeatureVisibility: {image: false, area: true}, selectionAreaEnabled: true, disableImageTranslator: true, videoTranslationEnabled: true})
    expect(migrated.popupQuickFeatureOrder).toEqual(['image', 'hover', 'selection', 'appearance', 'document'])
    expect(migrated.popupQuickFeatureVisibility.image).toBe(true)
    expect(migrated).toMatchObject({selectionAreaEnabled: true, disableImageTranslator: true, videoTranslationEnabled: true})
    expect(normalizePopupQuickFeatureVisibility({image: false, area: false}).image).toBe(false)
    expect(normalizeConfig(migrated)).toEqual(migrated)
  })

  it('默认保留四个入口，显式添加译文显示后仍持久保留', () => {
    const initial = normalizeConfig({})
    expect(initial.popupQuickFeatureOrder.filter(id => initial.popupQuickFeatureVisibility[id]))
      .toEqual(['hover', 'selection', 'image', 'document'])
    const visible = withPopupQuickFeatureVisibility(initial.popupQuickFeatureVisibility, 'appearance', true)
    expect(normalizeConfig({...initial, popupQuickFeatureVisibility: visible}).popupQuickFeatureVisibility.appearance).toBe(true)
  })

  it('清理历史信息高亮快捷入口的排序和显隐，保留独立阅读偏好', () => {
    const informationHighlight = {mode: 'surprisal-local', density: 'high', color: 'mint', style: 'underline'}
    const migrated = normalizeConfig({popupQuickFeatureOrder: ['highlight', 'image'], popupQuickFeatureVisibility: {highlight: true, image: false}, informationHighlight})
    expect(migrated.popupQuickFeatureOrder).toEqual(['image', 'hover', 'selection', 'appearance', 'document'])
    expect(migrated.popupQuickFeatureVisibility).not.toHaveProperty('highlight')
    expect(migrated.popupQuickFeatureVisibility.image).toBe(false)
    expect(migrated.informationHighlight).toEqual({enabled: false, hotkey: 'Alt+H', hotkeyEnabled: false, ...informationHighlight, model: 'qwen2.5-0.5b', intensity: 'standard'})
    expect(normalizeConfig(migrated)).toEqual(migrated)
  })

  it('每个快捷入口都有图标路径与色调，真实菜单栏和设置页预览共用同一份数据', () => {
    const ids = popupQuickFeatureOptions.map((item) => item.id).sort()
    expect(Object.keys(popupQuickFeatureIconPaths).sort()).toEqual(ids)
    expect(Object.keys(popupQuickFeatureIconTones).sort()).toEqual(ids)
    for (const id of ids) {
      expect(popupQuickFeatureIconPaths[id]).toMatch(/^M[\d\s.a-zA-Z-]+$/)
      expect(['rose', 'violet', 'amber', 'teal', 'blue']).toContain(popupQuickFeatureIconTones[id])
    }
    expect(new Set(Object.values(popupQuickFeatureIconTones)).size).toBe(5)
  })

  it('所有历史旧皮肤与未知 ID 稳定兜底回到默认皮肤，并保留当前注册皮肤', () => {
    for (const skin of interfaceSkinOptions) {
      expect(normalizeInterfaceSkin(skin.value)).toBe(skin.value)
    }
    const legacyOrUnknownSkins = [
      'plain', 'soft', 'minimal', 'compact', 'contrast',
      'qinghua', 'zhusha', 'shuimo', 'zhuqing', 'ouhe',
      'xiangse', 'qinglv', 'yuebai', 'xuanqing', 'wujin',
      'cheese', 'ocean', 'emoji', 'midnight', 'paper', 'arcade', 'sunset',
      'zen', 'dense', 'high-contrast', 'linear', 'nordic', 'raycast',
      'obsidian', 'washi', 'craft', 'botanical', 'braun',
      'constructor', '__proto__', 'unknown', '', null, undefined, 42,
    ]
    for (const legacy of legacyOrUnknownSkins) {
      expect(normalizeInterfaceSkin(legacy), String(legacy)).toBe('default')
      expect(getInterfaceSkinOption(legacy).value, String(legacy)).toBe('default')
      expect(normalizeConfig({interfaceSkin: legacy as string}).interfaceSkin, String(legacy)).toBe('default')
    }
    for (const font of interfaceFontOptions) {
      expect(normalizeInterfaceFont(font.value)).toBe(font.value)
    }
    expect(normalizeInterfaceFont('unknown')).toBe(DEFAULT_INTERFACE_FONT)
    expect(normalizeInterfaceFont(null)).toBe(DEFAULT_INTERFACE_FONT)
    expect(getInterfaceFontOption('noto-sans-sc').fontFamily).toContain('Noto Sans SC')
    expect(getInterfaceFontOption('unknown').value).toBe(DEFAULT_INTERFACE_FONT)
    expect(interfaceSkinUsesContentHeight('default')).toBe(true)
    expect(interfaceSkinUsesContentHeight('liquid-glass')).toBe(true)
    expect(interfaceSkinUsesContentHeight('cyber')).toBe(true)
    expect(interfaceSkinUsesContentHeight('unknown')).toBe(true)
    expect(getInterfaceSkinOption('unknown').popupWidth).toBe(320)

    expect(normalizeInterfaceVisibility({popupQuickFeatures: false})).toEqual({
      popupQuickFeatures: false,
      popupSiteRule: true,
      popupFooter: true,
    })
    expect(normalizeInterfaceVisibility({
      popupQuickFeatures: 'false',
      popupSiteRule: false,
      popupFooter: null,
      futureSection: false,
    })).toEqual({
      popupQuickFeatures: true,
      popupSiteRule: false,
      popupFooter: true,
    })
  })

  it('normalizeConfig 会清洗畸形的皮肤和栏目配置', () => {
    const normalized = normalizeConfig({
      interfaceSkin: 'matcha',
      interfaceVisibility: {popupQuickFeatures: false},
      popupModuleOrder: ['quickFeatures', 'translation', 'unknown', 'quickFeatures'],
      popupQuickFeatureOrder: ['document', 'hover', 'unknown', 'document'],
      popupQuickFeatureVisibility: {image: false},
    })

    expect(normalized.interfaceSkin).toBe('matcha')
    expect(normalized.interfaceVisibility).toEqual({
      popupQuickFeatures: false,
      popupSiteRule: true,
      popupFooter: true,
    })
    expect(normalized.popupModuleOrder).toEqual([
      'quickFeatures',
      'translation',
      'siteRule',
      'footer',
    ])
    expect(normalized.popupQuickFeatureOrder).toEqual([
      'document',
      'hover',
      'selection',
      'appearance',
      'image',
    ])
    expect(normalized.popupQuickFeatureVisibility).toEqual({
      hover: true,
      selection: true,
      appearance: false,
      image: false,
      document: true,
    })
    expect(normalizeConfig({
      interfaceSkin: 'invalid',
      interfaceFont: 'invalid',
      interfaceVisibility: [],
      popupModuleOrder: null,
      popupQuickFeatureOrder: null,
      popupQuickFeatureVisibility: null,
    })).toMatchObject({
      interfaceSkin: 'default',
      interfaceFont: DEFAULT_INTERFACE_FONT,
      interfaceVisibility: DEFAULT_INTERFACE_VISIBILITY,
      popupModuleOrder: DEFAULT_POPUP_MODULE_ORDER,
      popupQuickFeatureOrder: DEFAULT_POPUP_QUICK_FEATURE_ORDER,
      popupQuickFeatureVisibility: DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY,
    })
  })
})
