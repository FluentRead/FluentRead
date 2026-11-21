import type { Meta, StoryObj } from '@storybook/vue3'
import SettingsDemo from './SettingsDemo.vue'
const meta = {
  title: 'Examples/Settings', component: SettingsDemo, tags: ['autodocs'],
  args: {longLabels: false, needsSetup: false},
  parameters: {docs: {description: {component: '直接组合 SettingsGroup、SettingsItem 与 SettingsDisclosure。常用项常驻，次要项原生折叠，状态留在摘要；只有一个主按钮，次要动作使用中性色按钮或标题旁文字入口。'}}},
} satisfies Meta<typeof SettingsDemo>
export default meta
export const Reading: StoryObj<typeof meta> = { name: '设置组件组合' }
export const LongCopy: StoryObj<typeof meta> = {name: '长文案与窄屏', args: {longLabels: true}, parameters: {viewport: {defaultViewport: 'mobile'}}}
export const NeedsSetup: StoryObj<typeof meta> = {name: '折叠时保留待配置状态', args: {needsSetup: true}}
