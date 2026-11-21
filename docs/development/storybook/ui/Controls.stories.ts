import type { Meta, StoryObj } from '@storybook/vue3'
import ControlsDemo from './ControlsDemo.vue'
const meta = {
  title: 'UI/Controls', component: ControlsDemo, tags: ['autodocs'],
  parameters: { docs: { description: { component: '使用项目现有 Element Plus 组件及设置页样式，展示按钮、输入框、开关、帮助提示和弹窗交互。' } } },
} satisfies Meta<typeof ControlsDemo>
export default meta
export const Interactive: StoryObj<typeof meta> = { name: '基础控件与弹窗' }
