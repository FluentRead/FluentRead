import type { Meta, StoryObj } from '@storybook/vue3'
import SelectDemo from './SelectDemo.vue'

const meta = {
  title: 'UI/Select', component: SelectDemo, tags: ['autodocs'],
  args: { filterable: true, multiple: false, disabled: false, longLabels: false },
  parameters: { docs: { description: { component: '直接使用 src/ui/components/UiSelect.vue。可搜索、键盘选择、多选、长标签换行，状态保留在当前示例中。' } } },
} satisfies Meta<typeof SelectDemo>
export default meta
type Story = StoryObj<typeof meta>
export const Searchable: Story = { name: '搜索与选择' }
export const Multiple: Story = { name: '多选', args: { multiple: true } }
export const LongLabel: Story = { name: '长文案', args: { longLabels: true } }
export const Disabled: Story = { name: '禁用', args: { disabled: true } }
