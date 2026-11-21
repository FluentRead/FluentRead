import type { Meta, StoryObj } from '@storybook/vue3'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'

const meta = {
  title: 'UI/ServiceIcon', component: ServiceIcon, tags: ['autodocs'],
  args: { service: 'deepseek', label: 'DeepSeek', size: 'medium' },
  argTypes: { size: { control: 'inline-radio', options: ['small', 'medium', 'large', 'model'] } },
  parameters: { docs: { description: { component: '服务品牌图标使用扩展已有的本地 SVG 资源。图标作为装饰隐藏于辅助技术，名称应由相邻文字提供。' } } },
} satisfies Meta<typeof ServiceIcon>
export default meta
type Story = StoryObj<typeof meta>
export const Single: Story = { name: '尺寸与服务' }
export const Gallery: Story = {
  name: '服务图标集',
  render: (args) => ({ components: { ServiceIcon }, setup: () => ({ args, services: ['freeTranslation', 'google', 'microsoft', 'deepL', 'deepseek', 'openai', 'gemini', 'ollama', 'localTranslation', 'unknown'] }),
    template: '<div class="fr-story-grid"><div v-for="service in services" :key="service" class="fr-story-tile"><ServiceIcon v-bind="args" :service="service" :label="service" /><code>{{ service }}</code></div></div>',
  }),
}
export const Fallback: Story = { name: '未知服务', args: { service: 'unknown', label: '自定义服务' } }
