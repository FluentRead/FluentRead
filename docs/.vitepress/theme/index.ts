import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import ProductHome from './ProductHome.vue'
import ProductHomeEn from './ProductHomeEn.vue'
import DocsHome from './DocsHome.vue'
import TranslationDemo from './TranslationDemo.vue'
import GrammarDemo from './GrammarDemo.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ProductHome', ProductHome)
    app.component('ProductHomeEn', ProductHomeEn)
    app.component('DocsHome', DocsHome)
    app.component('TranslationDemo', TranslationDemo)
    app.component('GrammarDemo', GrammarDemo)
  },
} satisfies Theme
