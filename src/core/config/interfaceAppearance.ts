/**
 * @file src/core/config/interfaceAppearance.ts
 * 文件职责：集中定义 FluentRead 扩展 Popup 专属的 12 套风格化皮肤（3 大材质/美学系列 × 4 款）与界面字体元数据、分组顺序、旧皮肤统一回退默认逻辑及微缩预览色板。
 * 主要内容：提供 interfaceSkinGroups、interfaceSkinOptions、interfaceFontOptions 等只读注册表，纯 JSON 字面量以兼容油猴 AST 压缩插件；所有已退役或未知皮肤 ID 统一兜底回退到 'default'。
 * 模块边界：不操作 DOM、不读取浏览器存储或拉取外部字体；DOM 属性挂载与预览隔离由 src/ui/interfaceAppearance.ts 负责，皮肤仅作用于 Popup 与设置页局部预览容器。
 */

export const interfaceSkinGroups = [
  {
    value: 'atmosphere',
    label: '光影与材质',
    description: '液态玻璃、极光渐变与立体拟物键帽的现代质感表达。',
  },
  {
    value: 'expressive',
    label: '潮流与个性',
    description: '新粗野波普、赛博霓虹、经典复古桌面与极客终端的鲜明视觉世界。',
  },
  {
    value: 'editorial',
    label: '东方与人文',
    description: '典藏画报、樱雾物语、宇治手账与黑金典藏的独具韵味调性。',
  },
] as const

export type InterfaceSkinGroup = (typeof interfaceSkinGroups)[number]['value']
export type InterfaceSkinGroupId = InterfaceSkinGroup

export type InterfaceSkinToneMode = 'adaptive' | 'dark'

export type InterfaceSkinKind = 'default' | 'craft'

export type InterfaceSkinIconShape = 'rounded' | 'circle' | 'square'

export type InterfaceSkinCardStyle =
  | 'default'
  | 'liquid-glass'
  | 'aurora'
  | 'tactile'
  | 'brutalist'
  | 'cyber'
  | 'retro-os'
  | 'terminal'
  | 'editorial'
  | 'sakura'
  | 'matcha'
  | 'midnight-gold'

export interface InterfaceSkinPreviewPalette {
  readonly mat: string
  readonly canvas: string
  readonly surface: string
  readonly surfaceSoft: string
  readonly border: string
  readonly ink: string
  readonly muted: string
  readonly accent: string
  readonly actionBg: string
  readonly actionInk: string
  readonly iconBg: string
  readonly iconFg: string
  readonly swatches: readonly [string, string, string]
}

export interface InterfaceSkinPreviewSpec {
  readonly cardStyle: InterfaceSkinCardStyle
  readonly panelRadius: number
  readonly controlRadius: number
  readonly borderWidth: number
  readonly iconShape: InterfaceSkinIconShape
  readonly framelessHero: boolean
  readonly dense: boolean
  readonly light: InterfaceSkinPreviewPalette
  readonly dark: InterfaceSkinPreviewPalette
}

export const interfaceSkinOptions = [
  // === 系列一：光影与材质 ===
  {
    value: 'default',
    label: '默认经典',
    badge: '默认',
    description: '澄明留白与标志性玫红主操作，保留原生 FluentRead 的清晰与平衡。',
    group: 'atmosphere',
    kind: 'default',
    toneMode: 'adaptive',
    popupWidth: 320,
    popupHeight: 'content',
    preview: {
      cardStyle: 'default',
      panelRadius: 6,
      controlRadius: 4,
      borderWidth: 1,
      iconShape: 'rounded',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#eef1f6',
        canvas: '#ffffff',
        surface: '#ffffff',
        surfaceSoft: '#f5f6f9',
        border: '#e5e8f0',
        ink: '#172033',
        muted: '#667085',
        accent: '#ef4776',
        actionBg: 'linear-gradient(135deg, #f05a84 0%, #ea3c6f 100%)',
        actionInk: '#ffffff',
        iconBg: '#fef0f4',
        iconFg: '#d63362',
        swatches: ['#ffffff', '#f5f6f9', '#ef4776'],
      },
      dark: {
        mat: '#0d1016',
        canvas: '#14171c',
        surface: '#1b1f26',
        surfaceSoft: '#222731',
        border: '#2d3340',
        ink: '#eef1f6',
        muted: '#9ba4b5',
        accent: '#f36a8d',
        actionBg: 'linear-gradient(135deg, #f36a8d 0%, #e04674 100%)',
        actionInk: '#ffffff',
        iconBg: '#321c26',
        iconFg: '#f788a5',
        swatches: ['#14171c', '#222731', '#f36a8d'],
      },
    },
  },
  {
    value: 'liquid-glass',
    label: '液态玻璃',
    badge: '玻璃',
    description: '冷感冰蓝弥散光斑、半透明磨砂玻璃卡面与顶部镜面折射高光。',
    group: 'atmosphere',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 324,
    popupHeight: 'content',
    preview: {
      cardStyle: 'liquid-glass',
      panelRadius: 11,
      controlRadius: 6,
      borderWidth: 1,
      iconShape: 'circle',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#dbeafe',
        canvas: '#e8f1fb',
        surface: '#f5faff',
        surfaceSoft: '#eaf3fd',
        border: '#ffffff',
        ink: '#0b192c',
        muted: '#3b506b',
        accent: '#1466e6',
        actionBg: 'linear-gradient(180deg, #1466e6 0%, #0b4cc2 100%)',
        actionInk: '#ffffff',
        iconBg: '#eff6ff',
        iconFg: '#0e4fb8',
        swatches: ['#bae6fd', '#ddd6fe', '#1466e6'],
      },
      dark: {
        mat: '#0b1120',
        canvas: '#09111f',
        surface: '#142036',
        surfaceSoft: '#1e2e4a',
        border: '#324a70',
        ink: '#f0f7ff',
        muted: '#9ec0e0',
        accent: '#60b8ff',
        actionBg: 'linear-gradient(180deg, #1b6ce8 0%, #0f52c4 100%)',
        actionInk: '#ffffff',
        iconBg: '#162d4d',
        iconFg: '#85ccff',
        swatches: ['#09111f', '#38bdf8', '#1b6ce8'],
      },
    },
  },
  {
    value: 'aurora',
    label: '极光幻彩',
    badge: '极光',
    description: '全画布晨霞与北极光渐变氛围、悬浮珠光卡片与三段虹彩发光按钮。',
    group: 'atmosphere',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 322,
    popupHeight: 'content',
    preview: {
      cardStyle: 'aurora',
      panelRadius: 9,
      controlRadius: 5,
      borderWidth: 1,
      iconShape: 'rounded',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#f3e8ff',
        canvas: '#f8eefc',
        surface: '#fdfaff',
        surfaceSoft: '#f5ebfc',
        border: '#e5d4fa',
        ink: '#1e1330',
        muted: '#54446b',
        accent: '#7c3aed',
        actionBg: 'linear-gradient(120deg, #b8209a 0%, #7328d4 52%, #2554d4 100%)',
        actionInk: '#ffffff',
        iconBg: '#f3e8ff',
        iconFg: '#6b21a8',
        swatches: ['#fecdd3', '#c7d2fe', '#7328d4'],
      },
      dark: {
        mat: '#120f29',
        canvas: '#0b0e1e',
        surface: '#13172c',
        surfaceSoft: '#1e2442',
        border: '#3b2e66',
        ink: '#f4f3ff',
        muted: '#a7b0d6',
        accent: '#c084fc',
        actionBg: 'linear-gradient(120deg, #b8209a 0%, #6d28d9 52%, #0e7490 100%)',
        actionInk: '#ffffff',
        iconBg: '#2c1d4a',
        iconFg: '#d8b4fe',
        swatches: ['#14b8a6', '#d946ef', '#6d28d9'],
      },
    },
  },
  {
    value: 'tactile',
    label: '拟物硬件',
    badge: '立体',
    description: '哑光石瓷机身、物理立体凹凸键帽、内凹控件槽与发光 LED 指示灯。',
    group: 'atmosphere',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 324,
    popupHeight: 'content',
    preview: {
      cardStyle: 'tactile',
      panelRadius: 7,
      controlRadius: 4,
      borderWidth: 1,
      iconShape: 'rounded',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#dcd7ce',
        canvas: '#e4e0d8',
        surface: '#f1eee8',
        surfaceSoft: '#ddd8ce',
        border: '#c7c2b7',
        ink: '#1a1917',
        muted: '#524f49',
        accent: '#cc3f10',
        actionBg: 'linear-gradient(180deg, #cc3f10 0%, #b03209 100%)',
        actionInk: '#ffffff',
        iconBg: '#e7e2d9',
        iconFg: '#a8320a',
        swatches: ['#e4e0d8', '#f1eee8', '#cc3f10'],
      },
      dark: {
        mat: '#141518',
        canvas: '#18191c',
        surface: '#23252a',
        surfaceSoft: '#141518',
        border: '#353840',
        ink: '#f2f0eb',
        muted: '#a6a49d',
        accent: '#f26d3d',
        actionBg: 'linear-gradient(180deg, #cc3f10 0%, #ab3008 100%)',
        actionInk: '#ffffff',
        iconBg: '#2d3036',
        iconFg: '#ff946b',
        swatches: ['#18191c', '#23252a', '#cc3f10'],
      },
    },
  },

  // === 系列二：潮流与个性 ===
  {
    value: 'brutalist',
    label: '新粗野波普',
    badge: '波普',
    description: '奶油黄波点底纸、2px 纯黑粗框、硬偏移阴影与四色撞色功能磁贴。',
    group: 'expressive',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 324,
    popupHeight: 'content',
    preview: {
      cardStyle: 'brutalist',
      panelRadius: 2,
      controlRadius: 2,
      borderWidth: 2,
      iconShape: 'square',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#ffef9a',
        canvas: '#fff5cc',
        surface: '#ffffff',
        surfaceSoft: '#fff9e0',
        border: '#111111',
        ink: '#111111',
        muted: '#3f3c32',
        accent: '#d91b60',
        actionBg: '#ffde38',
        actionInk: '#111111',
        iconBg: '#ffe4ef',
        iconFg: '#111111',
        swatches: ['#fff5cc', '#ffde38', '#111111'],
      },
      dark: {
        mat: '#1f1d14',
        canvas: '#17161a',
        surface: '#222028',
        surfaceSoft: '#2d2a36',
        border: '#f5f2e6',
        ink: '#ffffff',
        muted: '#d6d2c4',
        accent: '#ffde38',
        actionBg: '#ffde38',
        actionInk: '#111111',
        iconBg: '#3b3314',
        iconFg: '#ffeb7a',
        swatches: ['#17161a', '#ffde38', '#f5f2e6'],
      },
    },
  },
  {
    value: 'cyber',
    label: '赛博霓虹',
    badge: '赛博',
    description: '常暗赛博正交网格、电光青与洋红双色霓虹光晕与高能等离子主按钮。',
    group: 'expressive',
    kind: 'craft',
    toneMode: 'dark',
    popupWidth: 324,
    popupHeight: 'content',
    preview: {
      cardStyle: 'cyber',
      panelRadius: 3,
      controlRadius: 2,
      borderWidth: 1,
      iconShape: 'square',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#070812',
        canvas: '#080616',
        surface: '#0f0d24',
        surfaceSoft: '#171433',
        border: '#00e5ff',
        ink: '#eef8ff',
        muted: '#93b4cc',
        accent: '#00e5ff',
        actionBg: 'linear-gradient(135deg, #c9146c 0%, #7c1fd9 100%)',
        actionInk: '#ffffff',
        iconBg: '#0c2c3d',
        iconFg: '#7af2ff',
        swatches: ['#080616', '#00e5ff', '#c9146c'],
      },
      dark: {
        mat: '#070812',
        canvas: '#080616',
        surface: '#0f0d24',
        surfaceSoft: '#171433',
        border: '#00e5ff',
        ink: '#eef8ff',
        muted: '#93b4cc',
        accent: '#00e5ff',
        actionBg: 'linear-gradient(135deg, #c9146c 0%, #7c1fd9 100%)',
        actionInk: '#ffffff',
        iconBg: '#0c2c3d',
        iconFg: '#7af2ff',
        swatches: ['#080616', '#00e5ff', '#c9146c'],
      },
    },
  },
  {
    value: 'retro-os',
    label: '经典复古桌面',
    badge: '复古',
    description: '致敬 90 年代经典系统：0px 像素锐角、3D 凿刻凸凹窗框、条纹顶栏与钴蓝按钮。',
    group: 'expressive',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 320,
    popupHeight: 'content',
    preview: {
      cardStyle: 'retro-os',
      panelRadius: 0,
      controlRadius: 0,
      borderWidth: 1,
      iconShape: 'square',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#008080',
        canvas: '#d4d2c8',
        surface: '#dfded6',
        surfaceSoft: '#ffffff',
        border: '#8c8b83',
        ink: '#111111',
        muted: '#42423d',
        accent: '#0b3d91',
        actionBg: '#0b3d91',
        actionInk: '#ffffff',
        iconBg: '#ffffff',
        iconFg: '#0a3580',
        swatches: ['#008080', '#dfded6', '#0b3d91'],
      },
      dark: {
        mat: '#143638',
        canvas: '#23252c',
        surface: '#2e313a',
        surfaceSoft: '#17191f',
        border: '#555a69',
        ink: '#f0f0eb',
        muted: '#b5b7bf',
        accent: '#68a0ff',
        actionBg: '#1f56b8',
        actionInk: '#ffffff',
        iconBg: '#1c2d4a',
        iconFg: '#8cb8ff',
        swatches: ['#143638', '#2e313a', '#1f56b8'],
      },
    },
  },
  {
    value: 'terminal',
    label: '极客终端',
    badge: 'CRT',
    description: '常暗 CRT 水平扫描线、全局等宽代码字体、荧光绿虚线框与磷光绿命令按钮。',
    group: 'expressive',
    kind: 'craft',
    toneMode: 'dark',
    popupWidth: 320,
    popupHeight: 'content',
    preview: {
      cardStyle: 'terminal',
      panelRadius: 0,
      controlRadius: 0,
      borderWidth: 1,
      iconShape: 'square',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#040a06',
        canvas: '#060b08',
        surface: '#0a140e',
        surfaceSoft: '#0f1f16',
        border: '#22c55e',
        ink: '#d9ffe6',
        muted: '#6ecb8f',
        accent: '#4ade80',
        actionBg: '#34d36e',
        actionInk: '#04140a',
        iconBg: '#10301d',
        iconFg: '#86efac',
        swatches: ['#060b08', '#1c472d', '#34d36e'],
      },
      dark: {
        mat: '#040a06',
        canvas: '#060b08',
        surface: '#0a140e',
        surfaceSoft: '#0f1f16',
        border: '#22c55e',
        ink: '#d9ffe6',
        muted: '#6ecb8f',
        accent: '#4ade80',
        actionBg: '#34d36e',
        actionInk: '#04140a',
        iconBg: '#10301d',
        iconFg: '#86efac',
        swatches: ['#060b08', '#1c472d', '#34d36e'],
      },
    },
  },

  // === 系列三：东方与人文 ===
  {
    value: 'editorial',
    label: '典藏画报',
    badge: '画报',
    description: '暖米报刊纸底、典雅衬线标题、无盒化双细线排版与深酒红印章按钮。',
    group: 'editorial',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 324,
    popupHeight: 'content',
    preview: {
      cardStyle: 'editorial',
      panelRadius: 0,
      controlRadius: 0,
      borderWidth: 1,
      iconShape: 'square',
      framelessHero: true,
      dense: false,
      light: {
        mat: '#e7e0d2',
        canvas: '#f5efe4',
        surface: '#faf6ee',
        surfaceSoft: '#efe8da',
        border: '#1c1917',
        ink: '#1c1917',
        muted: '#5c544b',
        accent: '#881c28',
        actionBg: '#7f1d28',
        actionInk: '#faf6ee',
        iconBg: '#f5efe4',
        iconFg: '#1c1917',
        swatches: ['#f5efe4', '#1c1917', '#7f1d28'],
      },
      dark: {
        mat: '#1b1814',
        canvas: '#151311',
        surface: '#1e1b18',
        surfaceSoft: '#28241f',
        border: '#c4b8a6',
        ink: '#f2ece1',
        muted: '#b0a697',
        accent: '#e07884',
        actionBg: '#9e2433',
        actionInk: '#faf6ee',
        iconBg: '#28241f',
        iconFg: '#f2ece1',
        swatches: ['#151311', '#c4b8a6', '#9e2433'],
      },
    },
  },
  {
    value: 'sakura',
    label: '樱雾物语',
    badge: '樱雾',
    description: '柔粉霞光渐层画布、棉花糖大圆角乳白卡面、莓果光泽胶囊钮与马卡龙四色图标。',
    group: 'editorial',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 322,
    popupHeight: 'content',
    preview: {
      cardStyle: 'sakura',
      panelRadius: 12,
      controlRadius: 6,
      borderWidth: 1,
      iconShape: 'circle',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#ffe1ec',
        canvas: '#fff0f6',
        surface: '#ffffff',
        surfaceSoft: '#fff2f7',
        border: '#f2c6d8',
        ink: '#331826',
        muted: '#754d60',
        accent: '#d4356f',
        actionBg: 'linear-gradient(135deg, #cf2e6a 0%, #ad1d55 100%)',
        actionInk: '#ffffff',
        iconBg: '#ffe0ec',
        iconFg: '#a81d52',
        swatches: ['#ffd4e5', '#e8dcff', '#cf2e6a'],
      },
      dark: {
        mat: '#2a1522',
        canvas: '#181016',
        surface: '#231720',
        surfaceSoft: '#2e1f2a',
        border: '#452e3e',
        ink: '#fcf0f5',
        muted: '#c9a3b6',
        accent: '#f472b6',
        actionBg: 'linear-gradient(135deg, #cf2e6a 0%, #ad1d55 100%)',
        actionInk: '#ffffff',
        iconBg: '#401c2d',
        iconFg: '#ffa3c7',
        swatches: ['#181016', '#452e3e', '#f472b6'],
      },
    },
  },
  {
    value: 'matcha',
    label: '宇治手账',
    badge: '抹茶',
    description: '青岚抹茶色底画布衬托暖白宣纸圆角卡片、深茶绿主操作与温润茶金点缀。',
    group: 'editorial',
    kind: 'craft',
    toneMode: 'adaptive',
    popupWidth: 322,
    popupHeight: 'content',
    preview: {
      cardStyle: 'matcha',
      panelRadius: 9,
      controlRadius: 5,
      borderWidth: 1,
      iconShape: 'rounded',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#c8dcc4',
        canvas: '#d7e7d6',
        surface: '#fbf8f0',
        surfaceSoft: '#f0ece0',
        border: '#cad9c7',
        ink: '#1c2b21',
        muted: '#4c6152',
        accent: '#2b6946',
        actionBg: 'linear-gradient(180deg, #2b6b47 0%, #1e5235 100%)',
        actionInk: '#ffffff',
        iconBg: '#f5eed6',
        iconFg: '#7c520d',
        swatches: ['#d7e7d6', '#fbf8f0', '#2b6b47'],
      },
      dark: {
        mat: '#101b14',
        canvas: '#101913',
        surface: '#18241c',
        surfaceSoft: '#213026',
        border: '#2c4032',
        ink: '#edf5ed',
        muted: '#9bb5a2',
        accent: '#57c98a',
        actionBg: 'linear-gradient(180deg, #276944 0%, #1c5234 100%)',
        actionInk: '#ffffff',
        iconBg: '#332b18',
        iconFg: '#ebd08a',
        swatches: ['#101913', '#276944', '#ebd08a'],
      },
    },
  },
  {
    value: 'midnight-gold',
    label: '黑金典藏',
    badge: '黑金',
    description: '常暗丝绒墨黑、顶部香槟金聚光晕、金属拉丝渐变金按钮与细金描边。',
    group: 'editorial',
    kind: 'craft',
    toneMode: 'dark',
    popupWidth: 324,
    popupHeight: 'content',
    preview: {
      cardStyle: 'midnight-gold',
      panelRadius: 4,
      controlRadius: 3,
      borderWidth: 1,
      iconShape: 'square',
      framelessHero: false,
      dense: false,
      light: {
        mat: '#0a0908',
        canvas: '#0a090d',
        surface: '#131218',
        surfaceSoft: '#1c1a22',
        border: '#c7a455',
        ink: '#f7f1e3',
        muted: '#b8ae99',
        accent: '#dfc076',
        actionBg: 'linear-gradient(135deg, #f0d797 0%, #d6b15c 52%, #bd9038 100%)',
        actionInk: '#140f05',
        iconBg: '#1c1914',
        iconFg: '#f0d99e',
        swatches: ['#0a090d', '#1c1a22', '#dfc076'],
      },
      dark: {
        mat: '#0a0908',
        canvas: '#0a090d',
        surface: '#131218',
        surfaceSoft: '#1c1a22',
        border: '#c7a455',
        ink: '#f7f1e3',
        muted: '#b8ae99',
        accent: '#dfc076',
        actionBg: 'linear-gradient(135deg, #f0d797 0%, #d6b15c 52%, #bd9038 100%)',
        actionInk: '#140f05',
        iconBg: '#1c1914',
        iconFg: '#f0d99e',
        swatches: ['#0a090d', '#1c1a22', '#dfc076'],
      },
    },
  },
] as const

export const interfaceFontOptions = [
  {
    value: 'system',
    labelKey: 'settings.interface.font.options.system.label',
    descriptionKey: 'settings.interface.font.options.system.description',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  {
    value: 'inter',
    labelKey: 'settings.interface.font.options.inter.label',
    descriptionKey: 'settings.interface.font.options.inter.description',
    fontFamily: '"FluentRead Inter", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'noto-sans-sc',
    labelKey: 'settings.interface.font.options.notoSansSc.label',
    descriptionKey: 'settings.interface.font.options.notoSansSc.description',
    fontFamily: '"FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'roboto',
    labelKey: 'settings.interface.font.options.roboto.label',
    descriptionKey: 'settings.interface.font.options.roboto.description',
    fontFamily: '"FluentRead Roboto", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'source-sans-3',
    labelKey: 'settings.interface.font.options.sourceSans3.label',
    descriptionKey: 'settings.interface.font.options.sourceSans3.description',
    fontFamily: '"FluentRead Source Sans 3", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'ibm-plex-sans',
    labelKey: 'settings.interface.font.options.ibmPlexSans.label',
    descriptionKey: 'settings.interface.font.options.ibmPlexSans.description',
    fontFamily: '"FluentRead IBM Plex Sans", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'manrope',
    labelKey: 'settings.interface.font.options.manrope.label',
    descriptionKey: 'settings.interface.font.options.manrope.description',
    fontFamily: '"FluentRead Manrope", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'nunito-sans',
    labelKey: 'settings.interface.font.options.nunitoSans.label',
    descriptionKey: 'settings.interface.font.options.nunitoSans.description',
    fontFamily: '"FluentRead Nunito Sans", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'lxgw-wenkai',
    labelKey: 'settings.interface.font.options.lxgwWenkai.label',
    descriptionKey: 'settings.interface.font.options.lxgwWenkai.description',
    fontFamily: '"FluentRead LXGW WenKai", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'noto-serif-sc',
    labelKey: 'settings.interface.font.options.notoSerifSc.label',
    descriptionKey: 'settings.interface.font.options.notoSerifSc.description',
    fontFamily: '"FluentRead Noto Serif SC", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
] as const

export type InterfaceFont = typeof interfaceFontOptions[number]['value']
export type InterfaceFontOption = typeof interfaceFontOptions[number]

export const DEFAULT_INTERFACE_FONT: InterfaceFont = 'system'

const interfaceFontByValue = new Map<string, InterfaceFontOption>(
  interfaceFontOptions.map((item) => [item.value, item]),
)

export type InterfaceSkin = typeof interfaceSkinOptions[number]['value']
export type InterfaceSkinOption = typeof interfaceSkinOptions[number]

const interfaceSkinByValue = new Map<string, InterfaceSkinOption>(
  interfaceSkinOptions.map((item) => [item.value, item]),
)

export const POPUP_MODULE_IDS = [
  'translation',
  'siteRule',
  'quickFeatures',
  'footer',
] as const

export type PopupModuleId = typeof POPUP_MODULE_IDS[number]

export const POPUP_QUICK_FEATURE_IDS = [
  'hover',
  'selection',
  'appearance',
  'image',
  'document',
] as const

export type PopupQuickFeatureId = typeof POPUP_QUICK_FEATURE_IDS[number]

export const INTERFACE_VISIBILITY_KEYS = [
  'popupQuickFeatures',
  'popupSiteRule',
  'popupFooter',
] as const

export type InterfaceVisibilityKey = typeof INTERFACE_VISIBILITY_KEYS[number]
export type InterfaceVisibility = Record<InterfaceVisibilityKey, boolean>
export type PopupQuickFeatureVisibility = Record<PopupQuickFeatureId, boolean>

export interface PopupModuleOption {
  id: PopupModuleId
  label: string
  description: string
  labelKey: string
  descriptionKey: string
  visibilityKey?: InterfaceVisibilityKey
  required?: boolean
}

export interface PopupQuickFeatureOption {
  id: PopupQuickFeatureId
  label: string
  description: string
  labelKey: string
  descriptionKey: string
}

export const popupModuleOptions: readonly PopupModuleOption[] = [
  {
    id: 'translation',
    label: '翻译控制',
    description: '翻译语言与各功能的服务提供商',
    labelKey: 'settings.interface.popupLayout.modules.translation.label',
    descriptionKey: 'settings.interface.popupLayout.modules.translation.description',
    required: true,
  },
  {
    id: 'siteRule',
    label: '当前网站栏目',
    description: '当前网站的始终翻译和禁用扩展开关',
    labelKey: 'settings.interface.popupLayout.modules.siteRule.label',
    descriptionKey: 'settings.interface.popupLayout.modules.siteRule.description',
    visibilityKey: 'popupSiteRule',
  },
  {
    id: 'quickFeatures',
    label: '快捷功能栏',
    description: '显示悬停、划词、图片和文档翻译入口',
    labelKey: 'settings.interface.popupLayout.modules.quickFeatures.label',
    descriptionKey: 'settings.interface.popupLayout.modules.quickFeatures.description',
    visibilityKey: 'popupQuickFeatures',
  },
  {
    id: 'footer',
    label: '底部信息栏',
    description: '显示翻译统计、开源项目入口和清除缓存操作',
    labelKey: 'settings.interface.popupLayout.modules.footer.label',
    descriptionKey: 'settings.interface.popupLayout.modules.footer.description',
    visibilityKey: 'popupFooter',
  },
] as const

/** 快捷功能卡片注册表；增加或移除入口时，顺序与可见性归一化会自动兼容旧配置。 */
export const popupQuickFeatureOptions: readonly PopupQuickFeatureOption[] = [
  {
    id: 'hover',
    label: '鼠标悬停翻译',
    description: '鼠标悬停时快速翻译文字',
    labelKey: 'settings.interface.popupQuickFeatures.modules.hover.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.hover.description',
  },
  {
    id: 'selection',
    label: '划词翻译',
    description: '选中网页文字后翻译',
    labelKey: 'settings.interface.popupQuickFeatures.modules.selection.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.selection.description',
  },
  {
    id: 'appearance',
    label: '译文显示',
    description: '快速调整译文的显示效果',
    labelKey: 'settings.interface.popupQuickFeatures.modules.appearance.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.appearance.description',
  },
  {
    id: 'image',
    label: '图片翻译',
    description: '识别并翻译图片中的文字',
    labelKey: 'settings.interface.popupQuickFeatures.modules.image.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.image.description',
  },
  {
    id: 'document',
    label: '文档翻译',
    description: '打开文档翻译入口',
    labelKey: 'settings.interface.popupQuickFeatures.modules.document.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.document.description',
  },
] as const

export const interfaceVisibilityOptions = INTERFACE_VISIBILITY_KEYS.map((key) => {
  const module = popupModuleOptions.find((item) => item.visibilityKey === key) as PopupModuleOption
  return {key, label: module.label, description: module.description}
})

export const DEFAULT_POPUP_MODULE_ORDER: PopupModuleId[] = [...POPUP_MODULE_IDS]
export const DEFAULT_POPUP_QUICK_FEATURE_ORDER: PopupQuickFeatureId[] = [...POPUP_QUICK_FEATURE_IDS]

export const DEFAULT_INTERFACE_VISIBILITY = Object.fromEntries(
  INTERFACE_VISIBILITY_KEYS.map((key) => [key, true]),
) as InterfaceVisibility

export const DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY = Object.fromEntries(
  POPUP_QUICK_FEATURE_IDS.map((id) => [id, id !== 'appearance']),
) as PopupQuickFeatureVisibility

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 规范化界面皮肤值；所有旧版已退役皮肤与未知值统一安全兜底回退到默认皮肤 `'default'`。 */
export function normalizeInterfaceSkin(value: unknown): InterfaceSkin {
  return getInterfaceSkinOption(value).value
}

/** 只接受内置字体栈，未知值稳定回到默认系统字体。 */
export function normalizeInterfaceFont(value: unknown): InterfaceFont {
  return getInterfaceFontOption(value).value
}

/** 返回字体栈元数据，让页面应用层不需要识别具体字体方案。 */
export function getInterfaceFontOption(value: unknown): InterfaceFontOption {
  return typeof value === 'string'
    ? interfaceFontByValue.get(value) ?? interfaceFontByValue.get(DEFAULT_INTERFACE_FONT)!
    : interfaceFontByValue.get(DEFAULT_INTERFACE_FONT)!
}

/** 返回完整皮肤元数据，所有已退役或未知皮肤 ID 稳定兜底回退到默认皮肤 `'default'`。 */
export function getInterfaceSkinOption(value: unknown): InterfaceSkinOption {
  if (typeof value !== 'string') return interfaceSkinOptions[0]
  return interfaceSkinByValue.get(value) ?? interfaceSkinOptions[0]
}

/** Popup 根据注册元数据决定是否使用内容高度，新增皮肤不需要修改 Popup 组件。 */
export function interfaceSkinUsesContentHeight(value: unknown): boolean {
  return getInterfaceSkinOption(value).popupHeight === 'content'
}

/** 只保留已注册的栏目开关；旧配置缺少新栏目时默认显示，保证升级不改变现有界面。 */
export function normalizeInterfaceVisibility(value: unknown): InterfaceVisibility {
  const source = isRecord(value) ? value : {}
  return Object.fromEntries(
    interfaceVisibilityOptions.map(({key}) => [
      key,
      typeof source[key] === 'boolean' ? source[key] : DEFAULT_INTERFACE_VISIBILITY[key],
    ]),
  ) as InterfaceVisibility
}

/** 返回新的可见性对象，避免设置页与全局配置共享嵌套引用时提前污染保存基线。 */
export function withInterfaceVisibility(
  value: unknown,
  key: InterfaceVisibilityKey,
  visible: boolean,
): InterfaceVisibility {
  return {
    ...normalizeInterfaceVisibility(value),
    [key]: visible,
  }
}

/** 只接受已注册快捷入口的布尔可见性；旧配置缺少的新入口默认显示。 */
export function normalizePopupQuickFeatureVisibility(value: unknown): PopupQuickFeatureVisibility {
  const source = isRecord(value) ? value : {}
  return Object.fromEntries(
    POPUP_QUICK_FEATURE_IDS.map((id) => [
      id,
      id === 'image' && source.area === true ? true : typeof source[id] === 'boolean' ? source[id] : DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY[id],
    ]),
  ) as PopupQuickFeatureVisibility
}

/** 用新对象更新单张快捷卡片的可见性，保证配置保存层能识别嵌套值变化。 */
export function withPopupQuickFeatureVisibility(
  value: unknown,
  id: PopupQuickFeatureId,
  visible: boolean,
): PopupQuickFeatureVisibility {
  return {
    ...normalizePopupQuickFeatureVisibility(value),
    [id]: visible,
  }
}

function normalizeRegisteredOrder<T extends string>(value: unknown, registeredIds: readonly T[]): T[] {
  const registered = new Set<unknown>(registeredIds)
  const seen = new Set<T>()
  const saved = Array.isArray(value)
    ? value.filter((item): item is T => {
        if (!registered.has(item) || seen.has(item as T)) return false
        seen.add(item as T)
        return true
      })
    : []

  return [
    ...saved,
    ...registeredIds.filter((id) => !seen.has(id)),
  ]
}

/**
 * 保存顺序只接受已注册模块，去除重复项，并按注册表顺序补上新模块。
 * 因此删除模块不需要迁移，新增模块也会稳定出现在旧用户布局末尾。
 */
export function normalizePopupModuleOrder(value: unknown): PopupModuleId[] {
  return normalizeRegisteredOrder(value, POPUP_MODULE_IDS)
}

/** 快捷入口顺序采用与顶层模块相同的插件式兼容策略。 */
export function normalizePopupQuickFeatureOrder(value: unknown): PopupQuickFeatureId[] {
  // 旧圈选入口并入图片，保留用户排列意图；视频配置本身不受入口收敛影响。
  const migrated = Array.isArray(value) ? value.map(id => id === 'area' ? 'image' : id) : value
  return normalizeRegisteredOrder(migrated, POPUP_QUICK_FEATURE_IDS)
}
