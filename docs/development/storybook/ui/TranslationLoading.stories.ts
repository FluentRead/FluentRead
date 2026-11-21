import type { Meta, StoryObj } from '@storybook/vue3'
import TranslationLoadingPreview from '@/src/ui/components/TranslationLoadingPreview.vue'
import { translationLoadingStyleOptions } from '@/src/core/config/translationLoadingStyle'

const meta = {
  title: 'UI/TranslationLoading', component: TranslationLoadingPreview, tags: ['autodocs'],
  args: { loadingStyle: 'ring', animated: true },
  argTypes: { loadingStyle: { control: 'select', options: translationLoadingStyleOptions.map((item) => item.value) } },
  parameters: { docs: { description: { component: '复用网页运行时加载指示器。关闭动画或启用系统减少动态效果后，仍保留静态反馈。' } } },
} satisfies Meta<typeof TranslationLoadingPreview>
export default meta
export const Single: StoryObj<typeof meta> = { name: '样式与动画' }
export const Static: StoryObj<typeof meta> = { name: '静态反馈', args: { animated: false } }
export const Gallery: StoryObj<typeof meta> = {
  name: '全部加载样式',
  render: (args) => ({ components: { TranslationLoadingPreview }, setup: () => ({ args, options: translationLoadingStyleOptions }), template: '<div class="fr-story-grid"><div v-for="option in options" :key="option.value" class="fr-story-tile"><TranslationLoadingPreview v-bind="args" :loading-style="option.value" /><strong style="margin-left: 10px">{{ option.label }}</strong><small>{{ option.description }}</small></div></div>' }),
}
