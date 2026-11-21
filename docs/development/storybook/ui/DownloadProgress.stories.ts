import type { Meta, StoryObj } from '@storybook/vue3'
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue'

const meta = {
  title: 'UI/DownloadProgress', component: DownloadProgress, tags: ['autodocs'],
  args: { label: '模型下载进度', detail: 'full', progress: { loaded: 12 * 1024 * 1024, total: 32 * 1024 * 1024 } },
  argTypes: { detail: { control: 'inline-radio', options: ['full', 'percent', 'none'] } },
  parameters: { docs: { description: { component: '使用真实 DownloadProgress 组件和固定演示字节数。总量未知时显示不确定进度，不伪造百分比；此处不发起下载。' } } },
} satisfies Meta<typeof DownloadProgress>
export default meta
type Story = StoryObj<typeof meta>
export const Determinate: Story = { name: '已知总量' }
export const Indeterminate: Story = { name: '总量未知', args: { progress: { loaded: 5 * 1024 * 1024, total: 0 } } }
export const Pending: Story = { name: '等待首个进度', args: { progress: undefined } }
export const Compact: Story = { name: '紧凑', args: { detail: 'percent' } }
export const Complete: Story = { name: '完成', args: { progress: { loaded: 32 * 1024 * 1024, total: 32 * 1024 * 1024 } } }
