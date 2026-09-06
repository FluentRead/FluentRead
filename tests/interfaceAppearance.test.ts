import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERFACE_VISIBILITY,
  DEFAULT_POPUP_MODULE_ORDER,
  DEFAULT_POPUP_QUICK_FEATURE_ORDER,
  DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY,
  getInterfaceSkinOption,
  interfaceSkinGroups,
  interfaceSkinOptions,
  interfaceSkinPopupWidth,
  interfaceSkinUsesContentHeight,
  interfaceVisibilityOptions,
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

describe('界面皮肤与栏目配置', () => {
  it('默认保留当前界面并显示所有 Popup 栏目', () => {
    const config = new Config()

    expect(config.interfaceSkin).toBe('default')
    expect(config.interfaceVisibility).toEqual(DEFAULT_INTERFACE_VISIBILITY)
    expect(config.popupModuleOrder).toEqual(DEFAULT_POPUP_MODULE_ORDER)
    expect(config.popupQuickFeatureOrder).toEqual(DEFAULT_POPUP_QUICK_FEATURE_ORDER)
    expect(config.popupQuickFeatureVisibility).toEqual(DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY)
    const expectedSkins = [
      'default',
      'minimal',
      'compact',
      'contrast',
      'cheese',
      'ocean',
      'matcha',
      'sakura',
      'emoji',
      'midnight',
      'paper',
      'aurora',
      'arcade',
      'sunset',
    ]
    expect(interfaceSkinOptions.map((item) => item.value)).toEqual(expectedSkins)
    expect(interfaceSkinOptions.map((item) => item.label)).toEqual([
      '默认风格',
      '简约风格',
      '紧凑风格',
      '高对比 ⚡',
      '奶酪 🧀',
      '海盐 🌊',
      '抹茶 🍵',
      '樱花 🌸',
      'Emoji 乐园 ✨',
      '夜幕 🌙',
      '纸张护眼 📖',
      '极光舷窗 🛰️',
      '像素街机 🎮',
      '落日公路 🛣️',
    ])
    expect(interfaceSkinGroups.map((item) => item.value)).toEqual(['utility', 'palette'])
    expect(interfaceSkinOptions.filter((item) => item.group === 'utility')).toHaveLength(4)
    expect(interfaceSkinOptions.filter((item) => item.group === 'palette')).toHaveLength(10)
    expect(new Set(interfaceSkinOptions.map((item) => JSON.stringify(item.preview))).size).toBe(14)
    expect(interfaceSkinOptions.filter(item => item.group === 'palette').every(item => item.motif === item.value)).toBe(true)
    expect(interfaceSkinOptions.filter(item => item.group === 'utility').every(item => item.motif === 'none')).toBe(true)
    expect(normalizeConfig({interfaceSkin: 'emoji'}).interfaceSkin).toBe('emoji')
    expect(interfaceSkinOptions.every((item) => interfaceSkinUsesContentHeight(item.value))).toBe(true)
    expect(interfaceSkinOptions.filter((item) => !['minimal', 'compact'].includes(item.value)).every((item) => item.popupWidth === 360)).toBe(true)
    expect(getInterfaceSkinOption('minimal').popupWidth).toBe(350)
    expect(getInterfaceSkinOption('compact').popupWidth).toBe(340)
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
      'area',
      'video',
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
      'area',
      'video',
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
      area: true,
      video: true,
      document: true,
    })
  })

  it('默认保留六个入口，显式添加译文显示后仍持久保留', () => {
    const initial = normalizeConfig({})
    expect(initial.popupQuickFeatureOrder.filter(id => initial.popupQuickFeatureVisibility[id]))
      .toEqual(['hover', 'selection', 'image', 'area', 'video', 'document'])
    const visible = withPopupQuickFeatureVisibility(initial.popupQuickFeatureVisibility, 'appearance', true)
    expect(normalizeConfig({...initial, popupQuickFeatureVisibility: visible}).popupQuickFeatureVisibility.appearance).toBe(true)
  })

  it('只接受注册皮肤，并为升级旧配置补齐栏目开关', () => {
    for (const skin of interfaceSkinOptions) {
      expect(normalizeInterfaceSkin(skin.value)).toBe(skin.value)
    }
    expect(normalizeInterfaceSkin('plain')).toBe('default')
    expect(normalizeInterfaceSkin('soft')).toBe('default')
    expect(normalizeInterfaceSkin('unknown')).toBe('default')
    expect(normalizeInterfaceSkin(null)).toBe('default')
    expect(getInterfaceSkinOption('cheese').label).toBe('奶酪 🧀')
    expect(getInterfaceSkinOption('aurora').description).toContain('极光')
    expect(getInterfaceSkinOption('arcade').motif).toBe('arcade')
    expect(getInterfaceSkinOption('sunset').preview.accent).toBe('#b64f3b')
    expect(getInterfaceSkinOption('unknown').value).toBe('default')
    expect(getInterfaceSkinOption(null).value).toBe('default')
    expect(interfaceSkinUsesContentHeight('default')).toBe(true)
    expect(interfaceSkinUsesContentHeight('minimal')).toBe(true)
    expect(interfaceSkinUsesContentHeight('paper')).toBe(true)
    expect(interfaceSkinUsesContentHeight('unknown')).toBe(true)
    expect(interfaceSkinPopupWidth('default')).toBe(360)
    expect(interfaceSkinPopupWidth('minimal')).toBe(350)
    expect(interfaceSkinPopupWidth('compact')).toBe(340)
    expect(interfaceSkinPopupWidth('unknown')).toBe(360)

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
      interfaceSkin: 'cheese',
      interfaceVisibility: {popupQuickFeatures: false},
      popupModuleOrder: ['quickFeatures', 'translation', 'unknown', 'quickFeatures'],
      popupQuickFeatureOrder: ['document', 'hover', 'unknown', 'document'],
      popupQuickFeatureVisibility: {image: false},
    })

    expect(normalized.interfaceSkin).toBe('cheese')
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
      'area',
      'video',
    ])
    expect(normalized.popupQuickFeatureVisibility).toEqual({
      hover: true,
      selection: true,
      appearance: false,
      image: false,
      area: true,
      video: true,
      document: true,
    })
    expect(normalizeConfig({
      interfaceSkin: 'invalid',
      interfaceVisibility: [],
      popupModuleOrder: null,
      popupQuickFeatureOrder: null,
      popupQuickFeatureVisibility: null,
    })).toMatchObject({
      interfaceSkin: 'default',
      interfaceVisibility: DEFAULT_INTERFACE_VISIBILITY,
      popupModuleOrder: DEFAULT_POPUP_MODULE_ORDER,
      popupQuickFeatureOrder: DEFAULT_POPUP_QUICK_FEATURE_ORDER,
      popupQuickFeatureVisibility: DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY,
    })
  })
})
