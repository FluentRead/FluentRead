import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// A standalone preview config; WXT entrypoints and browser APIs are not involved.
export default defineConfig({ plugins: [vue()] })
