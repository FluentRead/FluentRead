import type { Meta, StoryObj } from '@storybook/vue3'
import UiIcon from '@/src/ui/components/UiIcon.vue'

const names = ['home', 'layout', 'plug', 'translate', 'card', 'image', 'scan', 'captions', 'globe', 'pen', 'swap', 'book', 'glossary', 'chart', 'gauge', 'sliders', 'history', 'info', 'close', 'plus', 'search', 'chevron-down', 'arrow-right', 'external', 'grip', 'check', 'star', 'shield', 'keyboard']
const meta = {
  title: 'UI/UiIcon', component: UiIcon, tags: ['autodocs'],
  args: { name: 'translate', size: 24 },
  argTypes: { name: { control: 'select', options: names }, size: { control: { type: 'range', min: 12, max: 48, step: 2 } } },
  parameters: { docs: { description: { component: '扩展自有线条图标，继承文字颜色。纯图标按钮仍需要提供独立的可访问名称。' } } },
} satisfies Meta<typeof UiIcon>
export default meta
export const Single: StoryObj<typeof meta> = { name: '图标参数' }
export const Gallery: StoryObj<typeof meta> = {
  name: '图标集',
  render: (args) => ({ components: { UiIcon }, setup: () => ({ args, names }), template: '<div class="fr-story-grid"><div v-for="name in names" :key="name" class="fr-story-tile"><UiIcon v-bind="args" :name="name" /><code>{{ name }}</code></div></div>' }),
}
