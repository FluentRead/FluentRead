import { defineConfig } from 'wxt'

// CI skips install scripts, so shared component sources still need WXT's root
// TypeScript config. Discover HTML pages only: prepare reads their metadata without
// importing extension scripts, AI workers, or the production build configuration.
// This configuration is exclusively for the documentation workflow.
export default defineConfig({
  imports: false,
  hooks: {
    'entrypoints:found': (_wxt, entries) => {
      const pages = entries.filter(({ inputPath }) => inputPath.endsWith('.html'))
      entries.splice(0, entries.length, ...pages)
    },
  },
})
