import type { Meta, StoryObj } from '@storybook/vue3'
import Surfaces from './Surfaces.vue'
const meta = { title: 'Foundations/Surfaces', component: Surfaces, tags: ['autodocs'] } satisfies Meta<typeof Surfaces>
export default meta
export const RadiusAndElevation: StoryObj<typeof meta> = { name: '圆角与阴影' }
