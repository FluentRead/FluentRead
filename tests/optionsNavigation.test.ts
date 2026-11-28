import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NAVIGATION_SECTION,
  filterNavigationItems,
  filterSettingsSearchTargets,
  isUiLanguageSearch,
  navigationGroups,
  navigationItems,
  resolveNavigationItem,
  resolveRequestedSection,
  settingsSearchTargets,
  resolveSettingsPanel,
  SETTINGS_TABBED_SECTION_IDS,
  settingsPagePanels,
} from '@/src/features/settings/model/navigation'

describe('options navigation view-model', () => {
  it('keeps the sections unique, grouped exactly once and in the product IA order', () => {
    const groupedItems = navigationGroups.flatMap<(typeof navigationItems)[number]>((group) => group.items)
    expect(groupedItems).toEqual(navigationItems)
    expect(new Set(navigationItems.map((item) => item.id)).size).toBe(navigationItems.length)
    expect(navigationGroups.map((group) => ({
      label: group.label,
      items: group.items.map((item) => item.id),
    }))).toEqual([
      {
        label: '基础配置',
        items: ['settings-general', 'settings-services', 'settings-interface'],
      },
      {
        label: '翻译与交互',
        items: [
          'settings-translation',
          'settings-interactions',
          'settings-selection',
          'settings-writing',
          'settings-image-translation',
          'settings-video',
        ],
      },
      {
        label: '规则与工具',
        items: ['settings-sites', 'settings-glossary', 'settings-translation-center', 'settings-vocabulary', 'settings-translation-stats'],
      },
      {
        label: '系统与数据',
        items: ['settings-advanced', 'settings-data', 'settings-about'],
      },
    ])
    expect(navigationItems.map((item) => item.label)).toEqual([
      '通用设置',
      '翻译服务',
      '外观与界面',
      '网页翻译',
      '悬浮球与右键',
      '划词翻译',
      '输入与写作',
      '图片与漫画',
      '视频字幕',
      '网站规则',
      '术语库',
      '翻译中心',
      '学习中心',
      '翻译统计',
      '高级与隐私',
      '备份与恢复',
      '关于流畅阅读',
    ])
    expect(resolveNavigationItem('settings-translation')).toMatchObject({
      group: '翻译与交互',
      kicker: '翻译与交互',
    })
    expect(DEFAULT_NAVIGATION_SECTION).toBe('settings-general')
  })

  it('resolves valid sections and falls back for malformed hashes', () => {
    expect(resolveNavigationItem('settings-services').title).toBe('翻译服务')
    expect(resolveNavigationItem('settings-translation').title).toBe('网页翻译')
    expect(resolveNavigationItem('settings-interface').title).toBe('外观与界面')
    expect(resolveRequestedSection('#settings-glossary')).toBe('settings-glossary')
    expect(resolveNavigationItem('settings-glossary').group).toBe('规则与工具')
    expect(resolveNavigationItem('settings-model-usage').id).toBe('settings-translation-stats')
    expect(resolveRequestedSection('#settings-model-usage')).toBe('settings-translation-stats')
    expect(resolveSettingsPanel('settings-model-usage')).toBe('usage')
    expect(resolveSettingsPanel('settings-translation-stats')).toBe('overview')
    expect(resolveRequestedSection('#settings-translation-stats')).toBe('settings-translation-stats')
    expect(resolveNavigationItem('settings-translation-stats')).toMatchObject({group: '规则与工具', title: '翻译统计'})
    expect(resolveRequestedSection('#settings-harness')).toBe('settings-selection')
    expect(resolveRequestedSection('#settings-selection')).toBe('settings-selection')
    expect(resolveNavigationItem('settings-selection').group).toBe('翻译与交互')
    expect(resolveNavigationItem('settings-vocabulary').title).toBe('学习中心')
    expect(resolveRequestedSection('#settings-vocabulary')).toBe('settings-vocabulary')
    expect(resolveRequestedSection('#settings-learning-center')).toBe('settings-vocabulary')
    expect(resolveNavigationItem('missing').id).toBe(DEFAULT_NAVIGATION_SECTION)
    expect(resolveRequestedSection('#settings-area-translation')).toBe('settings-image-translation')
    expect(resolveSettingsPanel('settings-area-translation')).toBe('')
    expect(SETTINGS_TABBED_SECTION_IDS.has('settings-image-translation')).toBe(false)
    expect(resolveSettingsPanel('settings-image-translation')).toBe('')
    expect(resolveSettingsPanel('settings-image-translation', 'entries')).toBe('')
    expect(filterNavigationItems('圈选')).toEqual(expect.arrayContaining([expect.objectContaining({id: 'settings-image-translation'})]))
    expect(resolveRequestedSection('#settings-video')).toBe('settings-video')
    expect(resolveRequestedSection('settings-sites')).toBe('settings-sites')
    expect(resolveNavigationItem('settings-sites').group).toBe('规则与工具')
    expect(resolveSettingsPanel('settings-sites', 'preview')).toBe('preview')
    expect(SETTINGS_TABBED_SECTION_IDS.has('settings-sites')).toBe(false)
    expect(settingsPagePanels['settings-sites'].map(panel => panel.id)).toEqual(['rules', 'adaptation', 'preview'])
    expect(resolveRequestedSection('#settings-webpage')).toBe('settings-translation')
    expect(resolveRequestedSection('#settings-shortcuts')).toBe('settings-translation')
    expect(resolveRequestedSection('#settings-floating-ball')).toBe('settings-interactions')
    expect(resolveRequestedSection('#settings-context-menu')).toBe('settings-interactions')
    expect(resolveRequestedSection('#settings-input')).toBe('settings-writing')
    expect(resolveSettingsPanel('settings-floating-ball')).toBe('floating-ball')
    expect(resolveSettingsPanel('settings-context-menu')).toBe('context-menu')
    expect(resolveSettingsPanel('settings-input')).toBe('input')
    expect(resolveSettingsPanel('settings-interactions', 'tools')).toBe('floating-ball')
    expect(resolveSettingsPanel('settings-translation', 'paragraph-copy')).toBe('reading')
    expect(resolveSettingsPanel('settings-translation', 'section-translation')).toBe('hover')
    expect(resolveRequestedSection('#settings-interface')).toBe('settings-interface')
    expect(resolveRequestedSection('#missing')).toBe(DEFAULT_NAVIGATION_SECTION)
  })

  it('searches all user-facing metadata case-insensitively and trims input', () => {
    expect(filterNavigationItems('阅读记录')).toEqual([expect.objectContaining({id: 'settings-vocabulary'})])
    expect(filterNavigationItems(' glossary ')).toEqual([expect.objectContaining({id: 'settings-glossary'})])
    expect(filterNavigationItems(' OPENAI ')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'settings-services' }),
    ]))
    expect(filterNavigationItems('主域名')).toEqual([
      expect.objectContaining({ id: 'settings-sites' }),
    ])
    expect(filterNavigationItems('AI 智能上下文')).toEqual([
      expect.objectContaining({ id: 'settings-translation' }),
    ])
    expect(filterNavigationItems('液态玻璃')).toEqual([
      expect.objectContaining({ id: 'settings-interface' }),
    ])
    expect(filterNavigationItems('极光幻彩')).toEqual([
      expect.objectContaining({ id: 'settings-interface' }),
    ])
    expect(filterNavigationItems('菜单栏布局')).toEqual([
      expect.objectContaining({ id: 'settings-interface' }),
    ])
    expect(filterNavigationItems('典藏画报')).toEqual([
      expect.objectContaining({ id: 'settings-interface' }),
    ])
    // 译文样式与颜色都集中在外观与界面页，不再同时命中通用设置。
    for (const keyword of ['译文样式', '下划线颜色', '译文颜色', '标记底色', '模糊遮罩']) {
      expect(filterNavigationItems(keyword)).toEqual([
        expect.objectContaining({ id: 'settings-interface' }),
      ])
    }
    expect(filterNavigationItems('翻译模式')).toEqual([
      expect.objectContaining({ id: 'settings-general' }),
    ])
    expect(filterNavigationItems('鼠标悬浮')).toEqual([
      expect.objectContaining({ id: 'settings-translation' }),
    ])
    expect(filterNavigationItems('AI 多段翻译')).toEqual([
      expect.objectContaining({ id: 'settings-translation' }),
    ])
    expect(filterNavigationItems('快捷方案')).toEqual([
      expect.objectContaining({ id: 'settings-translation' }),
    ])
    expect(filterNavigationItems('聚合平台')).toEqual([
      expect.objectContaining({ id: 'settings-services' }),
    ])
    expect(filterNavigationItems('Token')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'settings-translation-stats' }),
    ]))
    for (const keyword of ['翻译统计', '平均耗时', '最长耗时', 'P95', '请求规模']) {
      expect(filterNavigationItems(keyword)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'settings-translation-stats' }),
      ]))
    }
    expect(filterNavigationItems('备份与恢复')).toEqual([
      expect.objectContaining({ id: 'settings-data' }),
    ])
    for (const keyword of ['全部节点', '网页标题', '侧栏', '段落处理']) {
      expect(filterNavigationItems(keyword)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'settings-translation' }),
      ]))
    }
    expect(filterNavigationItems('')).toEqual([])
    expect(filterNavigationItems('不存在的设置项')).toEqual([])
    for (const keyword of ['翻译卡片', 'AI 讲解', '学习程度', '学习记忆']) {
      expect(filterNavigationItems(keyword)).toEqual([
        expect.objectContaining({ id: 'settings-selection' }),
      ])
    }
    expect(filterNavigationItems('Harness')).toEqual([])
  })
})

describe('settings control search', () => {
  it('finds the exact floating-ball switch label and its detailed settings', () => {
    expect(filterSettingsSearchTargets('按功能选择翻译服务')).toEqual([
      expect.objectContaining({sectionId: 'settings-general', targetId: 'feature-services'}),
    ])
    expect(filterSettingsSearchTargets('全文翻译悬浮球')).toEqual([
      expect.objectContaining({sectionId: 'settings-interactions', targetId: 'floating-ball-settings'}),
    ])
    expect(filterSettingsSearchTargets('悬浮球').map(item => item.id)).toEqual([
      'floating-ball-toggle', 'floating-ball-settings',
    ])
    expect(filterSettingsSearchTargets('悬浮球配置').map(item => item.sectionId)).toEqual([
      'settings-interactions', 'settings-interactions',
    ])
    expect(filterSettingsSearchTargets('  ')).toEqual([])
    expect(new Set(settingsSearchTargets.map(item => item.id)).size).toBe(settingsSearchTargets.length)
  })

  it('jumps to reading assistance and independent highlight appearance settings', () => {
    expect(filterSettingsSearchTargets('逐句高亮')).toEqual([
      expect.objectContaining({sectionId: 'settings-translation', targetId: 'translation-sentence-highlight-style'}),
      expect.objectContaining({sectionId: 'settings-translation', targetId: 'translation-sentence-highlight-style'}),
    ])
    for (const keyword of ['译文外观', '线条颜色', '标记底色', '译文字号']) {
      expect(filterSettingsSearchTargets(keyword)).toEqual([
        expect.objectContaining({sectionId: 'settings-interface', targetId: 'translation-appearance-panel'}),
      ])
    }
  })

  it('routes smart highlighting searches to the reading panel anchor without mixing bilingual search terms', () => {
    expect(SETTINGS_TABBED_SECTION_IDS.has('settings-translation')).toBe(false)
    const panels = settingsPagePanels['settings-translation']
    expect(panels.find(panel => panel.id === 'reading')).toMatchObject({
      targetIds: expect.arrayContaining(['translation-sentence-highlight', 'information-highlight-settings', 'personal-corrections-settings']),
    })
    expect(resolveSettingsPanel('settings-translation', 'personal-corrections-settings')).toBe('reading')
    expect(panels.find(panel => panel.id === 'reading')?.searchTerms).not.toMatch(/智能高亮|信息高亮|意外度|surprisal|关键词|本地模型/u)
    for (const keyword of ['智能高亮', '意外度', 'surprisal', '关键词']) {
      const matches = filterSettingsSearchTargets(keyword)
      expect(matches).toEqual([expect.objectContaining({id: 'information-highlight', label: '智能高亮'})])
      expect(resolveSettingsPanel(matches[0].sectionId, matches[0].targetId)).toBe('reading')
    }
    expect(resolveSettingsPanel('settings-translation', 'information-highlight')).toBe('reading')
    expect(resolveSettingsPanel('settings-translation', 'translation-sentence-highlight')).toBe('reading')
  })
})

 describe('interface language recovery search', () => {
  it.each(['lan', 'LANGUAGE', '  language  ', '语言', '語言', '言語', '언어', 'langue', 'idioma', 'язык', 'Sprache', 'língua', 'لغة'])('finds the language control across UI locales: %s', query => {
    expect(isUiLanguageSearch(query)).toBe(true)
    const translated = navigationItems.map(item => ({...item, label: 'unrelated', description: '', heading: '', summary: '', searchDescription: ''}))
    expect(filterNavigationItems(query, translated)[0]?.id).toBe('settings-general')
  })
  it('does not treat blank or unrelated searches as language recovery', () => {
    expect(isUiLanguageSearch(' ')).toBe(false)
    expect(isUiLanguageSearch('OpenAI')).toBe(false)
    expect(filterNavigationItems('')).toEqual([])
  })
})

it('普通搜索维持原导航顺序', () => { expect(filterNavigationItems('翻译').length).toBeGreaterThan(1); });

it('语言搜索在多个匹配项中优先显示通用设置', () => { const matches=filterNavigationItems('语'); expect(matches.length).toBeGreaterThan(1);expect(matches[0].id).toBe('settings-general'); });


describe('settings page categories', () => {
  it('opens the category that owns a deep-linked control', () => {
    expect(resolveSettingsPanel('settings-interactions', 'floating-ball-settings')).toBe('floating-ball')
    expect(resolveSettingsPanel('settings-interactions', 'context-menu-settings')).toBe('context-menu')
    expect(resolveSettingsPanel('settings-translation', 'paragraph-copy-settings')).toBe('reading')
    expect(resolveSettingsPanel('settings-translation', 'section-translation-settings')).toBe('hover')
    expect(resolveSettingsPanel('settings-translation', 'excluded-language-settings')).toBe('excluded-languages')
    expect(resolveSettingsPanel('settings-translation', 'excluded-tag-settings')).toBe('excluded-tags')
    expect(resolveSettingsPanel('settings-interface', 'translation-appearance-panel')).toBe('translation')
    expect(resolveSettingsPanel('settings-translation', 'translation-sentence-highlight-style')).toBe('reading')
    expect(settingsPagePanels['settings-translation'][0].id).toBe('page')
    expect(resolveSettingsPanel('settings-interface', 'font')).toBe('font')
  })
  it('falls back safely for old or unknown category links', () => {
    expect(resolveSettingsPanel('settings-interactions', 'tools')).toBe('floating-ball')
    expect(resolveSettingsPanel('settings-interface', 'missing')).toBe('translation')
    expect(resolveSettingsPanel('settings-interface')).toBe('translation')
    expect(resolveSettingsPanel('settings-general')).toBe('')
    expect(resolveSettingsPanel('unknown', 'cache')).toBe('')
    for (const section of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(resolveSettingsPanel(section, 'cache')).toBe('')
    }
  })
  it('keeps every category attached to a real settings page without ambiguous targets', () => {
    for (const [section, panels] of Object.entries(settingsPagePanels)) {
      expect(navigationItems.some(item => item.id === section)).toBe(true)
      expect(new Set(panels.map(panel => panel.id)).size).toBe(panels.length)
      const targets = panels.flatMap(panel => panel.targetIds)
      expect(new Set(targets).size).toBe(targets.length)
    }
  })
})
