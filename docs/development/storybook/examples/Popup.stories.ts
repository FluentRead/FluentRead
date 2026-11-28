import type { Meta, StoryObj } from '@storybook/vue3'
import PopupDemo from './PopupDemo.vue'

const meta = {
  title: 'Examples/Popup',
  component: PopupDemo,
  tags: ['autodocs'],
  parameters: {
    viewport: { defaultViewport: 'popup' },
    docs: {
      description: {
        component: '320px Popup 设计规范示例：消除渐变与发光噪音、统一同心圆角、≥11px 可读底线、纯色高对比主按钮与物理按压反馈。',
      },
    },
  },
} satisfies Meta<typeof PopupDemo>

export default meta
export const DefaultPopup: StoryObj<typeof meta> = { name: 'Popup 320px 主控面板' }
