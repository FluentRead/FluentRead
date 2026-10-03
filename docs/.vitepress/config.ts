import brandTaglines from '../../src/core/i18n/messages/brand-taglines.json'
import { defineConfig, type DefaultTheme } from 'vitepress'

const supportUrl = 'https://github.com/FluentRead/FluentRead#support'

const guide = (en = false): DefaultTheme.SidebarItem[] => {
  const p = en ? '/en' : ''
  const item = (zh: string, english: string, path: string) => ({
    text: en ? english : zh,
    link: p + path,
  })
  return [
    {
      text: en ? 'Start here' : '快速开始',
      items: [
        item('文档首页', 'Documentation', '/docs/'),
        item('安装与第一次翻译', 'Installation & first translation', '/guide/getting-started'),
        item('功能概览', 'Feature overview', '/guide/features'),
      ],
    },
    {
      text: en ? 'Webpage translation' : '网页翻译',
      items: [
        item('全文与局部翻译', 'Page & section translation', '/guide/webpage-translation'),
        item('划词与 AI 讲解', 'Selection & AI explanations', '/guide/deepseek-harness'),
        item('悬浮段落翻译', 'Hover translation', '/guide/hover-translation'),
        item('输入框翻译', 'Input translation', '/guide/input-translation'),
        item('翻译中心', 'Translation Center', '/guide/translation-center'),
      ],
    },
    {
      text: en ? 'Images, documents & video' : '图片、文档与视频',
      items: [
        item('图片翻译', 'Image translation', '/guide/image-translation'),
        item('圈选翻译', 'Area translation', '/guide/area-translation'),
        item('文档翻译', 'Document translation', '/guide/document-translation'),
        item('视频与会议字幕', 'Video & meeting captions', '/guide/video-subtitles'),
      ],
    },
    {
      text: en ? 'Learning & expression' : '学习与表达',
      items: [
        item('学习中心', 'Learning center', '/guide/vocabulary-book'),
        item('词性与句法', 'Sentence structure', '/guide/sentence-analysis'),
        item('双语分享卡片', 'Share cards', '/guide/share-cards'),
        item('写作助手', 'Writing assistant', '/guide/writing-assistant'),
      ],
    },
    {
      text: en ? 'Providers & settings' : '服务与设置',
      collapsed: false,
      items: [
        item('设置概览', 'Settings overview', '/config/'),
        item('翻译服务', 'Translation providers', '/config/translation-engines'),
        item('译文外观与阅读辅助', 'Appearance & reading aids', '/config/appearance'),
        item('术语库', 'Glossaries', '/guide/glossary'),
        item('快捷键与触发方式', 'Shortcuts & triggers', '/guide/custom-hotkey'),
        item('网站规则与阅读范围', 'Site rules & reading area', '/config/site-adaptation'),
        item('备份与同步', 'Backup & sync', '/config/backup-sync'),
        item('WebDAV 云备份', 'WebDAV cloud backup', '/guide/webdav'),
        ...(!en ? [{text: 'Dropbox 同步接入', link: '/config/dropbox-sync'}] : []),
        item('翻译统计', 'Translation statistics', '/guide/translation-stats'),
        item('模型用量', 'AI usage', '/guide/model-usage'),
      ],
    },
    {
      text: en ? 'More platforms' : '更多平台',
      collapsed: true,
      items: [
        item('Chrome 本地翻译', 'Chrome local translation', '/guide/chrome-translator'),
        item('油猴脚本', 'Userscript', '/guide/userscript'),
        item('Thunderbird 邮件翻译', 'Thunderbird email translation', '/guide/thunderbird'),
      ],
    },
    {
      text: en ? 'Help' : '帮助',
      items: [
        item('常见问题', 'Troubleshooting', '/guide/faq'),
        item('隐私政策', 'Privacy policy', '/guide/privacy'),
        { text: en ? 'Support the project' : '支持项目', link: supportUrl },
      ],
    },
  ]
}
const theme = (en = false): DefaultTheme.Config => ({
  nav: [
    { text: en ? 'Features' : '功能', link: en ? '/en/#features' : '/#features' },
    {
      text: en ? 'Documentation' : '使用文档',
      link: en ? '/en/docs/' : '/docs/',
      activeMatch: '^/(en/)?(docs|guide|config)/',
    },
    { text: en ? 'Help' : '帮助', link: en ? '/en/guide/faq' : '/guide/faq' },
    {
      text: en ? 'Install' : '安装',
      link: en ? '/en/guide/getting-started#install' : '/guide/getting-started#安装',
    },
  ],
  sidebar: en
    ? { '/en/docs/': guide(true), '/en/guide/': guide(true), '/en/config/': guide(true) }
    : { '/docs/': guide(), '/guide/': guide(), '/config/': guide() },
  outline: {
    level: [2, 3] as [number, number],
    label: en ? 'On this page' : '这一页',
  },
  docFooter: { prev: en ? 'Previous' : '上一篇', next: en ? 'Next' : '下一篇' },
  sidebarMenuLabel: en ? 'Menu' : '目录',
  returnToTopLabel: en ? 'Back to top' : '回到顶部',
  darkModeSwitchLabel: en ? 'Appearance' : '外观',
  lightModeSwitchTitle: en ? 'Switch to light theme' : '切换浅色',
  darkModeSwitchTitle: en ? 'Switch to dark theme' : '切换深色',
  langMenuLabel: en ? 'Language' : '切换语言',
  lastUpdated: { text: en ? 'Last updated' : '最后更新' },
  footer: {
    message: en
      ? `${brandTaglines['en-US']} · <a href="/en/guide/privacy">Privacy policy</a>`
      : `${brandTaglines['zh-CN']} · <a href="/guide/privacy">隐私政策</a>`,
    copyright: '© FluentRead · GPL-3.0',
  },
})
export default defineConfig({
  title: 'FluentRead',
  description: `${brandTaglines['zh-CN']} 一款开源的浏览器双语翻译插件。`,
  lang: 'zh-CN',
  base: '/',
  sitemap: { hostname: 'https://read.thinkstu.com' },
  transformHead({ pageData }) {
    if (pageData.relativePath === '404.md') {
      return [['meta', { name: 'robots', content: 'noindex' }]]
    }
    let route = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '')
    route = route.replace(/^(en\/)?guide\/$/, '$1docs/')
    route = route.replace(/^(en\/)?writing-assistant$/, '$1guide/writing-assistant')
    route = route.replace(/^(en\/)?guide\/privacy-policy$/, '$1guide/privacy')
    const canonical = `https://read.thinkstu.com/${route}`
    const opposite = route.startsWith('en/') ? route.slice(3) : `en/${route}`
    return [
      ['link', { rel: 'canonical', href: canonical }],
      [
        'link',
        { rel: 'alternate', hreflang: route.startsWith('en/') ? 'en' : 'zh-CN', href: canonical },
      ],
      [
        'link',
        {
          rel: 'alternate',
          hreflang: route.startsWith('en/') ? 'zh-CN' : 'en',
          href: `https://read.thinkstu.com/${opposite}`,
        },
      ],
      ['meta', { property: 'og:site_name', content: 'FluentRead' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:url', content: canonical }],
    ]
  },
  lastUpdated: true,
  cleanUrls: true,
  srcExclude: [
    'architecture.md',
    'testing.md',
    'reports/**',
    'maintainers/**',
    'contributing/**',
    'development/**',
    'free-translation-apis.md',
  ],
  head: [
    ['meta', { name: 'theme-color', content: '#b8214e' }],
    ['link', { rel: 'icon', href: '/logo.webp' }],
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'FluentRead',
      themeConfig: theme(),
    },
    en: {
      label: 'English',
      lang: 'en',
      title: 'FluentRead',
      description: `${brandTaglines['en-US']} An open-source browser extension for bilingual translation.`,
      themeConfig: theme(true),
    },
  },
  themeConfig: {
    logo: '/logo.webp',
    siteTitle: 'FluentRead',
    socialLinks: [{ icon: 'github', link: 'https://github.com/FluentRead/FluentRead' }],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索使用指南' },
              modal: {
                noResultsText: '没有找到相关内容',
                resetButtonTitle: '清空搜索',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭',
                },
              },
            },
          },
        },
      },
    },
  },
})
