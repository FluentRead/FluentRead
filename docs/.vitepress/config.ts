import { defineConfig } from 'vitepress'
import { localeBootstrap } from './theme/locale-preference.mjs'

const guide = (en = false) => {
  const p = en ? '/en' : ''
  const item = (zh: string, english: string, path: string) => ({
    text: en ? english : zh,
    link: p + path,
  })
  return [
    {
      text: en ? 'Getting started' : '开始使用',
      items: [
        item('使用指南', 'User guide', '/guide/'),
        item('安装与第一次翻译', 'Installation', '/guide/getting-started'),
        item(
          '网页与划词翻译',
          'Webpage and selection translation',
          '/guide/features'
        ),
      ],
    },
    {
      text: en ? 'Translation and learning' : '翻译与学习',
      items: [
        item('翻译卡', 'Reading card', '/guide/deepseek-harness'),
        item('学习中心', 'Learning center', '/guide/vocabulary-book'),
        item('图片翻译', 'Image translation', '/guide/image-translation'),
        item('圈选翻译', 'Area translation', '/guide/area-translation'),
        item('文档翻译', 'Documents', '/guide/document-translation'),
        item('视频字幕', 'Video subtitles', '/guide/video-subtitles'),
      ],
    },
    {
      text: en ? 'Settings' : '设置',
      items: [
        item('设置', 'Settings', '/config/'),
        item('翻译服务', 'Translation services', '/config/translation-engines'),
        item('术语库', 'Glossaries', '/guide/glossary'),
        item(
          '快捷键与触发方式',
          'Shortcuts & triggers',
          '/guide/custom-hotkey'
        ),
        item('网站阅读范围', 'Website reading area', '/config/site-adaptation'),
        item('模型用量', 'AI usage', '/guide/model-usage'),
        item(
          'Chrome 本地翻译',
          'Chrome local translation',
          '/guide/chrome-translator'
        ),
        item('油猴脚本', 'Userscript', '/guide/userscript'),
      ],
    },
    {
      text: en ? 'Help' : '帮助',
      items: [
        item('常见问题', 'Troubleshooting', '/guide/faq'),
        item('数据与隐私', 'Data & privacy', '/guide/privacy'),
        item('支持项目', 'Support the project', '/guide/support'),
      ],
    },
  ]
}
const theme = (en = false) => ({
  nav: [
    {
      text: en ? 'Features' : '功能',
      link: en ? '/en/guide/features' : '/guide/features',
    },
    {
      text: en ? 'User guide' : '使用指南',
      link: en ? '/en/guide/' : '/guide/',
    },
    {
      text: en ? 'Help' : '帮助',
      link: en ? '/en/guide/faq' : '/guide/faq',
    },
    {
      text: en ? 'Install' : '安装',
      link: en
        ? '/en/guide/getting-started#install'
        : '/guide/getting-started#安装',
    },
    {
      text: en ? 'Support' : '支持项目',
      link: en ? '/en/guide/support' : '/guide/support',
    },
  ],
  sidebar: en
    ? { '/en/guide/': guide(true), '/en/config/': guide(true) }
    : { '/guide/': guide(), '/config/': guide() },
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
  footer: {
    message: en
      ? 'FluentRead · Open-source bilingual reading'
      : 'FluentRead · 开源双语阅读扩展',
    copyright: '© FluentRead · GPL-3.0',
  },
})
export default defineConfig({
  title: 'FluentRead · 流畅阅读',
  description:
    'FluentRead 是一款开源双语阅读与翻译扩展，支持网页、图片、文档和字幕翻译，翻译卡接入经浏览器适配的 DeepSeek Harness 会话内核。',
  lang: 'zh-CN',
  base: '/',
  cleanUrls: true,
  srcExclude: [
    'architecture.md',
    'testing.md',
    'reports/**',
    'maintainers/**',
    'contributing/**',
    'free-translation-apis.md',
  ],
  head: [
    ['script', {}, localeBootstrap],
    ['meta', { name: 'theme-color', content: '#bc2854' }],
    ['link', { rel: 'icon', href: '/logo.webp' }],
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'FluentRead · 流畅阅读',
      themeConfig: theme(),
    },
    en: {
      label: 'English',
      lang: 'en',
      title: 'FluentRead',
      description:
        'Open-source bilingual reading, with a browser adaptation of the DeepSeek Harness session core for AI reading conversations.',
      themeConfig: theme(true),
    },
  },
  themeConfig: {
    logo: '/logo.webp',
    siteTitle: 'FluentRead',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/FluentRead/FluentRead' },
    ],
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
