import { ref, watch } from 'vue'
import type { Meta, StoryObj } from '@storybook/vue3'
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue'

const meta = {
  title: 'UI/FeatureEnableCard', component: FeatureEnableCard, tags: ['autodocs'],
  args: { modelValue: true, title: '划词翻译', description: '选中网页文字，查看译文与学习卡片。', disabled: false },
  render: (args) => ({
    components: { FeatureEnableCard },
    setup() {
      const enabled = ref(args.modelValue)
      watch(() => args.modelValue, (value) => { enabled.value = value })
      return { args, enabled }
    },
    template: '<div class="fr-story-stack"><FeatureEnableCard v-bind="args" v-model="enabled" /><small>当前状态：{{ enabled ? "已开启" : "已关闭" }}</small></div>',
  }),
  parameters: { docs: { description: { component: '整块卡片都是开关。支持鼠标、空格与 Enter，通过 aria-checked 表达启停状态；示例只更新本地状态。' } } },
} satisfies Meta<typeof FeatureEnableCard>
export default meta
type Story = StoryObj<typeof meta>
export const Enabled: Story = { name: '开启' }
export const DisabledFeature: Story = { name: '关闭', args: { modelValue: false } }
export const Unavailable: Story = { name: '不可用', args: { disabled: true, modelValue: false } }
export const LongDescription: Story = { name: '长文案与窄屏', args: { title: '自动识别网页文字并展示双语阅读辅助', description: '较长的说明会自然换行。切换到工具栏的 Popup 或 Mobile 视口，检查标题、说明与开关是否完整可见。' } }
