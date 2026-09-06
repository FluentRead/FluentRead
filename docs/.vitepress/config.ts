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
      text: en ? 'Start reading' : '开始读',
      items: [
        item('使用指南', 'Find your way', '/guide/'),
        item('安装与第一次翻译', 'Install & try it', '/guide/getting-started'),
        item(
          '网页与随手翻译',
          'Webpage & quick translation',
          '/guide/features'
        ),
      ],
    },
    {
      text: en ? 'A little more' : '再多看两眼',
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
      text: en ? 'Make it yours' : '用得顺手',
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
      text: en ? 'Need a hand?' : '遇到问题',
      items: [
        item('常见问题', 'Troubleshooting', '/guide/faq'),
        item('数据与隐私', 'Data & privacy', '/guide/privacy'),
      ],
    },
  ]
}
const theme = (en = false) => ({
  nav: [
    {
      text: en ? 'What it does' : '能做什么',
      link: en ? '/en/guide/features' : '/guide/features',
    },
    { text: en ? 'Guide' : '怎么用', link: en ? '/en/guide/' : '/guide/' },
    {
      text: en ? 'Help' : '遇到问题',
      link: en ? '/en/guide/faq' : '/guide/faq',
    },
    {
      text: en ? 'Install' : '安装',
      link: en
        ? '/en/guide/getting-started#install'
        : '/guide/getting-started#安装',
    },
  ],
  sidebar: en
    ? { '/en/guide/': guide(true), '/en/config/': guide(true) }
    : { '/guide/': guide(), '/config/': guide() },
  outline: {
    level: [2, 3] as [number, number],
    label: en ? 'On this page' : '这一页',
  },
  docFooter: { prev: en ? 'Previous' : '上一篇', next: en ? 'Next' : '接着看' },
  sidebarMenuLabel: en ? 'Menu' : '目录',
  returnToTopLabel: en ? 'Back to top' : '回到顶部',
  darkModeSwitchLabel: en ? 'Appearance' : '外观',
  lightModeSwitchTitle: en ? 'Switch to light theme' : '切换浅色',
  darkModeSwitchTitle: en ? 'Switch to dark theme' : '切换深色',
  langMenuLabel: en ? 'Language' : '切换语言',
  footer: {
    message: en ? 'Another language? Keep reading.' : '外语？照样读。',
    copyright: '© FluentRead · GPL-3.0',
  },
})
export default defineConfig({
  title: 'FluentRead · 流畅阅读',
  description:
    '外语？照样读。FluentRead 开源双语阅读扩展，接入 DeepSeek Harness 会话内核的浏览器适配，让难句可以接着问。',
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
