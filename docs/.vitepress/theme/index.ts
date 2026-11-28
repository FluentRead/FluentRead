import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import ProductHome from './ProductHome.vue'
import ProductHomeEn from './ProductHomeEn.vue'
import DocsHome from './DocsHome.vue'
import TranslationDemo from './TranslationDemo.vue'
import GrammarDemo from './GrammarDemo.vue'
import GuideVisual from './GuideVisual.vue'
import BrandReader from './BrandReader.vue'
import GuideLayout from './GuideLayout.vue'
import BrowserInstall from './BrowserInstall.vue'
import DocDiagram from './diagrams/DocDiagram.vue'
import './custom.css'
import './homepage.css'
import './diagrams/diagrams.css'

export default {
  extends: DefaultTheme,
  Layout: GuideLayout,
  enhanceApp({ app }) {
    app.component('ProductHome', ProductHome)
    app.component('ProductHomeEn', ProductHomeEn)
    app.component('DocsHome', DocsHome)
    app.component('TranslationDemo', TranslationDemo)
    app.component('GrammarDemo', GrammarDemo)
    app.component('GuideVisual', GuideVisual)
    app.component('BrandReader', BrandReader)
    app.component('BrowserInstall', BrowserInstall)
    app.component('DocDiagram', DocDiagram)
  },
} satisfies Theme
