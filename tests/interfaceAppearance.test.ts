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

describe('界面皮肤与栏目配置', () => {
  it('默认保留当前界面并显示所有 Popup 栏目', () => {
    const config = new Config()

    expect(config.interfaceSkin).toBe('default')
    expect(config.interfaceFont).toBe('system')
    expect(config.interfaceVisibility).toEqual(DEFAULT_INTERFACE_VISIBILITY)
    expect(config.popupModuleOrder).toEqual(DEFAULT_POPUP_MODULE_ORDER)
    expect(config.popupQuickFeatureOrder).toEqual(DEFAULT_POPUP_QUICK_FEATURE_ORDER)
    expect(config.popupQuickFeatureVisibility).toEqual(DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY)
    const expectedSkins = [
      'default',
      'minimal',
      'compact',
      'contrast',
      'qinghua',
      'zhusha',
      'shuimo',
      'zhuqing',
      'ouhe',
      'xiangse',
      'qinglv',
      'yuebai',
      'xuanqing',
      'wujin',
    ]
    expect(interfaceSkinOptions.map((item) => item.value)).toEqual(expectedSkins)
    expect(interfaceSkinOptions.map((item) => item.label)).toEqual([
      '默认风格',
      '简约风格',
      '紧凑风格',
      '高对比 ⚡',
      '青花',
      '朱砂',
      '水墨',
      '竹青',
      '藕荷',
      '缃色',
      '青绿',
      '月白',
      '玄青',
      '乌金',
    ])
    expect(interfaceSkinGroups.map((item) => item.label)).toEqual(['效率与可读性', '传统色风格'])
    expect(interfaceSkinGroups.map((item) => item.value)).toEqual(['utility', 'palette'])
    expect(interfaceSkinOptions.filter((item) => item.group === 'utility')).toHaveLength(4)
    expect(interfaceSkinOptions.filter((item) => item.group === 'palette')).toHaveLength(10)
    expect(new Set(interfaceSkinOptions.map((item) => JSON.stringify(item.preview))).size).toBe(14)
    // 缩略图用注册表里的静态取值画出版面、品牌行、卡片与主按钮；风格不再登记任何背景图案。
    const hex = /^#[0-9a-f]{6}$/
    const fill = /^(#[0-9a-f]{6}|linear-gradient\(\d+deg(, #[0-9a-f]{6}){2,3}\))$/
    for (const {kind, preview} of interfaceSkinOptions) {
      for (const color of [preview.canvas, preview.surface, preview.border, preview.ink, preview.title, preview.accent]) expect(color).toMatch(hex)
      expect(preview.backdrop).toMatch(fill)
      expect(preview.action).toMatch(fill)
      expect(preview.radius).toBeGreaterThanOrEqual(0)
      expect(preview.radius).toBeLessThanOrEqual(10)
      // 传统色风格全部平涂：缩略图里的版面与主按钮也只能是纯色。
      if (kind === 'palette') {
        expect(preview.backdrop).toBe(preview.canvas)
        expect(preview.action).toMatch(hex)
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
    expect(normalizeConfig({interfaceSkin: 'shuimo'}).interfaceSkin).toBe('shuimo')
    expect(normalizeConfig({interfaceFont: 'noto-sans-sc'}).interfaceFont).toBe('noto-sans-sc')
    expect(interfaceSkinOptions.every((item) => interfaceSkinUsesContentHeight(item.value))).toBe(true)
    expect(interfaceSkinOptions.filter((item) => !['minimal', 'compact'].includes(item.value)).every((item) => item.popupWidth === 320)).toBe(true)
    expect(getInterfaceSkinOption('minimal').popupWidth).toBe(310)
    expect(getInterfaceSkinOption('compact').popupWidth).toBe(300)
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
      // 线条图标画在 24×24 的画布上，路径由若干以 M 开头的子路径组成。
      expect(popupQuickFeatureIconPaths[id]).toMatch(/^M[\d\s.a-zA-Z-]+$/)
      expect(['rose', 'violet', 'amber', 'teal', 'blue']).toContain(popupQuickFeatureIconTones[id])
    }
    expect(new Set(Object.values(popupQuickFeatureIconTones)).size).toBe(5)
  })

  it('只接受注册皮肤，并为升级旧配置补齐栏目开关', () => {
    for (const skin of interfaceSkinOptions) {
      expect(normalizeInterfaceSkin(skin.value)).toBe(skin.value)
    }
    expect(normalizeInterfaceSkin('plain')).toBe('default')
    expect(normalizeInterfaceSkin('soft')).toBe('default')
    expect(normalizeInterfaceSkin('unknown')).toBe('default')
    expect(normalizeInterfaceSkin(null)).toBe('default')
    for (const font of interfaceFontOptions) {
      expect(normalizeInterfaceFont(font.value)).toBe(font.value)
    }
    expect(normalizeInterfaceFont('unknown')).toBe(DEFAULT_INTERFACE_FONT)
    expect(normalizeInterfaceFont(null)).toBe(DEFAULT_INTERFACE_FONT)
    expect(getInterfaceFontOption('noto-sans-sc').fontFamily).toContain('Noto Sans SC')
    expect(getInterfaceFontOption('unknown').value).toBe(DEFAULT_INTERFACE_FONT)
    expect(getInterfaceSkinOption('qinghua').label).toBe('青花')
    expect(getInterfaceSkinOption('qinghua').preview.action).toBe('#183a65')
    expect(getInterfaceSkinOption('zhusha').preview.accent).toBe('#c3272b')
    expect(getInterfaceSkinOption('xiangse').preview.action).toBe('#f0c239')
    expect(getInterfaceSkinOption('yuebai').preview.canvas).toBe('#d6ecf0')
    expect(getInterfaceSkinOption('wujin').description).toContain('始终为深色')
    // 已下线的十套风格换成接替它的传统色风格，保存过旧 ID 的配置不会退回默认界面。
    expect(Object.fromEntries(['cheese', 'ocean', 'matcha', 'sakura', 'emoji', 'midnight', 'paper', 'aurora', 'arcade', 'sunset']
      .map((retired) => [retired, normalizeInterfaceSkin(retired)]))).toEqual({
      cheese: 'xiangse',
      ocean: 'yuebai',
      matcha: 'zhuqing',
      sakura: 'ouhe',
      emoji: 'ouhe',
      midnight: 'xuanqing',
      paper: 'shuimo',
      aurora: 'xuanqing',
      arcade: 'qinglv',
      sunset: 'zhusha',
    })
    expect(normalizeConfig({interfaceSkin: 'midnight'}).interfaceSkin).toBe('xuanqing')
    expect(getInterfaceSkinOption('constructor').value).toBe('default')
    expect(getInterfaceSkinOption('unknown').value).toBe('default')
    expect(getInterfaceSkinOption(null).value).toBe('default')
    expect(interfaceSkinUsesContentHeight('default')).toBe(true)
    expect(interfaceSkinUsesContentHeight('minimal')).toBe(true)
    expect(interfaceSkinUsesContentHeight('shuimo')).toBe(true)
    expect(interfaceSkinUsesContentHeight('unknown')).toBe(true)
    expect(getInterfaceSkinOption('default').popupWidth).toBe(320)
    expect(getInterfaceSkinOption('minimal').popupWidth).toBe(310)
    expect(getInterfaceSkinOption('compact').popupWidth).toBe(300)
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
      interfaceSkin: 'zhuqing',
      interfaceVisibility: {popupQuickFeatures: false},
      popupModuleOrder: ['quickFeatures', 'translation', 'unknown', 'quickFeatures'],
      popupQuickFeatureOrder: ['document', 'hover', 'unknown', 'document'],
      popupQuickFeatureVisibility: {image: false},
    })

    expect(normalized.interfaceSkin).toBe('zhuqing')
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
