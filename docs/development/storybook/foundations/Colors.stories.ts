import type { Meta, StoryObj } from '@storybook/vue3'
import Colors from './Colors.vue'

const meta = {
  title: 'Foundations/Colors', component: Colors, tags: ['autodocs'],
  parameters: { docs: { description: { component: '直接读取 FluentRead 当前主题与皮肤的颜色，避免独立维护一份色板。' } } },
} satisfies Meta<typeof Colors>
export default meta
export const Palette: StoryObj<typeof meta> = { name: '色板', args: { contrast: false } }
export const Contrast: StoryObj<typeof meta> = { name: '对比度', args: { contrast: true } }
