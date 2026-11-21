import type {Meta, StoryObj} from '@storybook/vue3'
import {ref} from 'vue'
import {ElInput} from 'element-plus'
import SettingsDisclosure from '@/src/features/settings/ui/components/SettingsDisclosure.vue'
import SettingsItem from '@/src/features/settings/ui/components/SettingsItem.vue'

const meta = {
  title: 'UI/SettingsDisclosure', component: SettingsDisclosure, tags: ['autodocs'],
  args: {title: '按功能选择服务', description: '需要独立服务时再展开。', status: '跟随默认服务', statusTone: 'neutral', defaultOpen: false},
  argTypes: {statusTone: {control: 'select', options: ['neutral', 'warning', 'danger']}},
  render: args => ({
    components: {SettingsDisclosure, SettingsItem, ElInput},
    setup() {return {args, draft: ref('这里的输入会在收起后保留。')}},
    template: '<SettingsDisclosure v-bind="args" id="storybook-disclosure" data-settings-anchor="services"><SettingsItem label="本地草稿" stacked><ElInput v-model="draft" aria-label="本地草稿" /></SettingsItem></SettingsDisclosure>',
  }),
  parameters: {docs: {description: {component: '原生 details/summary 保留浏览器键盘行为。默认插槽一直挂载，折叠不重建表单。id、锚点和 toggle 监听透传到根节点；defaultOpen 只设置初始展开状态，业务状态和持久化由调用方负责。'}}},
} satisfies Meta<typeof SettingsDisclosure>
export default meta
type Story = StoryObj<typeof meta>
export const Collapsed: Story = {name: '中性摘要'}
export const Warning: Story = {name: '需要处理的状态', args: {status: '待配置', statusTone: 'warning'}}
export const Expanded: Story = {name: '初始展开并保留草稿', args: {defaultOpen: true}}
