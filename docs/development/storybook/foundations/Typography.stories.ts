import type { Meta, StoryObj } from '@storybook/vue3'
import Typography from './Typography.vue'
const meta = { title: 'Foundations/Typography', component: Typography, tags: ['autodocs'] } satisfies Meta<typeof Typography>
export default meta
export const Hierarchy: StoryObj<typeof meta> = { name: '字号与字体栈' }
