import { addons } from 'storybook/manager-api'
import { create } from 'storybook/theming'

addons.setConfig({
  theme: create({
    base: 'light',
    brandTitle: 'FluentRead UI',
    brandUrl: 'https://read.thinkstu.com/guide/design-system',
    brandTarget: '_blank',
    colorPrimary: '#ef4776',
    colorSecondary: '#dc315f',
  }),
})
