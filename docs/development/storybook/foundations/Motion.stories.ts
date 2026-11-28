import type { Meta, StoryObj } from '@storybook/vue3'
import Motion from './Motion.vue'

const meta = {
  title: 'Foundations/Motion',
  component: Motion,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: '展示 FluentRead 统一的动效时长、Emil 缓出物理曲线与按压缩放反馈，全部自动响应 prefers-reduced-motion。',
      },
    },
  },
} satisfies Meta<typeof Motion>

export default meta
export const CurvesAndPress: StoryObj<typeof meta> = { name: '缓动与微交互' }
