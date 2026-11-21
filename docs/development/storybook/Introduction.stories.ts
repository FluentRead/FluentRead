import type { Meta, StoryObj } from '@storybook/vue3'
import Introduction from './Introduction.vue'

const meta = { title: 'Overview/Introduction', component: Introduction, tags: ['autodocs'] } satisfies Meta<typeof Introduction>
export default meta
export const Welcome: StoryObj<typeof meta> = { name: '使用方式' }
