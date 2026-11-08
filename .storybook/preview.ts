import {setup, type Preview} from '@storybook/vue3'
import {ElInputNumber} from 'element-plus'
import { interfaceSkinOptions } from '../src/core/config/interfaceAppearance'
import { previewLanguage } from '../storybook/preview-i18n'
import 'element-plus/es/components/base/style/css'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/input-number/style/css'
import 'element-plus/es/components/switch/style/css'
import 'element-plus/es/components/dialog/style/css'
import 'element-plus/es/components/tooltip/style/css'
// Use the real Options theme and skin declarations, including their dark values.
import '../src/features/settings/ui/settings-page.css'
import '../src/ui/styles/interface-skins.css'
import '../storybook/preview.css'

// SettingsNumberInput 与 Options 使用同名全局控件，示例只注册展示所需的依赖。
setup(app => { app.component('ElInputNumber', ElInputNumber) })

const preview: Preview = {
  tags: ['autodocs'],
  globalTypes: {
    theme: {
      description: '明暗主题',
      toolbar: { icon: 'circlehollow', dynamicTitle: true, items: [
        { value: 'light', title: '浅色' }, { value: 'dark', title: '深色' },
      ] },
    },
    skin: {
      description: '界面皮肤',
      toolbar: { icon: 'paintbrush', dynamicTitle: true,
        items: interfaceSkinOptions.map(({ value, label }) => ({ value, title: label })),
      },
    },
    locale: {
      description: '组件内置文案语言',
      toolbar: { icon: 'globe', dynamicTitle: true, items: [
        { value: 'zh-CN', title: '中文' }, { value: 'en-US', title: 'English' },
      ] },
    },
  },
  initialGlobals: { theme: 'light', skin: 'default', locale: 'zh-CN' },
  decorators: [(story, context) => {
    const root = document.documentElement
    const skin = interfaceSkinOptions.find((item) => item.value === context.globals.skin) ?? interfaceSkinOptions[0]
    root.classList.toggle('dark', context.globals.theme === 'dark')
    root.dataset.interfaceSkin = skin.value
    root.dataset.interfaceSkinKind = skin.kind
    root.lang = context.globals.locale === 'en-US' ? 'en-US' : 'zh-CN'
    previewLanguage.value = root.lang === 'en-US' ? 'en-US' : 'zh-CN'
    return { components: { story }, template: '<div class="fr-story-surface"><story /></div>' }
  }],
  parameters: {
    layout: 'padded',
    backgrounds: { disable: true },
    options: { storySort: { order: ['Overview', 'Foundations', 'UI', 'Examples'] } },
    controls: { expanded: true },
    docs: { toc: true },
    viewport: { options: {
      popup: { name: 'Popup · 320px', styles: { width: '320px', height: '640px' } },
      mobile: { name: 'Mobile · 390px', styles: { width: '390px', height: '844px' } },
      desktop: { name: 'Desktop · 1280px', styles: { width: '1280px', height: '800px' } },
    } },
  },
}
export default preview
