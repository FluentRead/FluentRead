import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/vue3-vite'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const config: StorybookConfig = {
  stories: ['../**/*.stories.ts'],
  addons: ['@storybook/addon-docs'],
  framework: {
    name: '@storybook/vue3-vite',
    options: { builder: { viteConfigPath: fileURLToPath(new URL('./vite.config.ts', import.meta.url)) } },
  },
  core: { disableTelemetry: true, disableProjectJson: true },
  async viteFinal(config) {
    const { mergeConfig } = await import('vite')
    return mergeConfig(config, {
      base: './',
      resolve: {
        alias: [
          // Only the isolated preview replaces the extension's storage-backed UI context.
          { find: /^@\/src\/ui\/i18n$/, replacement: fileURLToPath(new URL('../preview-i18n.ts', import.meta.url)) },
          { find: '@', replacement: root.replace(/\/$/, '') },
        ],
      },
      build: { sourcemap: false },
    })
  },
}
export default config
