import type { Meta, StoryObj } from '@storybook/vue3'
import { ref } from 'vue'
import SegmentedControl, { type SegmentedOption } from '@/src/features/settings/ui/components/SegmentedControl.vue'

const meta = {
  title: 'UI/SegmentedControl',
  component: SegmentedControl,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: '用于 2–4 个互斥设置的紧凑分段选择控件，支持方向键循环导航与多语言换行。',
      },
    },
  },
} satisfies Meta<typeof SegmentedControl>

export default meta
type Story = StoryObj<typeof meta>

const modeOptions: SegmentedOption[] = [
  { label: '仅译文模式', value: 0 },
  { label: '双语对照模式', value: 1 },
]

export const Default: Story = {
  name: '默认',
  args: { modelValue: 1, options: modeOptions, label: '翻译模式', compact: false, disabled: false },
  render: (args) => ({
    components: { SegmentedControl },
    setup() {
      const value = ref(args.modelValue)
      return { args, value }
    },
    template: '<div style="max-width: 360px"><SegmentedControl v-model="value" :options="args.options" :label="args.label" :compact="args.compact" :disabled="args.disabled" /></div>',
  }),
}

export const Compact: Story = {
  name: '紧凑行内',
  args: {
    modelValue: 'auto',
    options: [
      { label: '跟随系统', value: 'auto' },
      { label: '浅色', value: 'light' },
      { label: '深色', value: 'dark' },
    ],
    label: '界面主题',
    compact: true,
    disabled: false,
  },
  render: Default.render,
}
