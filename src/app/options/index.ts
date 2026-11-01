/**
 * @file src/app/options/index.ts
 * 文件职责：创建 Options Vue 应用并集中注册页面所需的 Element Plus 组件、图标与样式，向 WXT 入口暴露稳定挂载函数。
 * 主要内容：维护显式组件和图标清单，载入 Element Plus、settings-page 及共享 token 样式，分别传递自有 UI 扫描根与扩展 document 元信息权限；配置与界面资源就绪后复验安全水合状态和最新语言、字体，再创建 OptionsApp、逐项注册并挂载到给定 selector；启动期间页面退出则终止迟到挂载，所有结束路径释放临时监听。
 * 模块边界：此文件只做 UI 依赖装配，不实现导航、设置保存或业务组件；OptionsApp 管理页面状态，各 feature 负责配置和词汇逻辑，WXT 入口决定启动时机。
 */
import { createApp, type App, type Component } from 'vue'
import {prepareInterfaceFont} from '@/src/ui/interfaceAppearance'
import {
  ElButton,
  ElDialog,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElOption,
  ElOptionGroup,
  ElSwitch,
  ElTooltip,
} from 'element-plus'
import {
  CircleCheckFilled,
  Coffee,
  Download,
  Edit,
  InfoFilled,
  Loading,
  Refresh,
  Setting,
  Upload,
  Warning,
  WarningFilled,
} from '@element-plus/icons-vue'
import OptionsApp from './OptionsApp.vue'
import UiSelect from '@/src/ui/components/UiSelect.vue'
import 'element-plus/es/components/base/style/css'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/dialog/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/input-number/style/css'
import 'element-plus/es/components/option/style/css'
import 'element-plus/es/components/option-group/style/css'
import 'element-plus/es/components/popover/style/css'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/switch/style/css'
import 'element-plus/es/components/tooltip/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/color-picker/style/css'
import '@/src/features/settings/ui/settings-page.css'
import {createUiI18nPlugin} from '@/src/ui/i18n'
import '@/src/ui/styles/interface-skins.css'
import {config, configReady, getConfigHydrationStatus} from '@/src/services/config/store'
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles'

const ELEMENT_COMPONENTS: Component[] = [
  ElButton,
  ElDialog,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElOption,
  ElOptionGroup,
  ElSwitch,
  ElTooltip,
]

const ELEMENT_ICONS: Record<string, Component> = {
  CircleCheckFilled,
  Coffee,
  Download,
  Edit,
  InfoFilled,
  Loading,
  Refresh,
  Setting,
  Upload,
  Warning,
  WarningFilled,
}

export interface OptionsAppInstallOptions {
  /**
   * 扩展 Options 使用 document.body；userscript 的完整 Options UI 挂在 closed ShadowRoot
   * 时传 null，禁止修改宿主网页元信息；可用 uiRoot 仅扫描当前自有 UI 容器。
   */
  documentRoot?: HTMLElement | null;
  /** 自有 UI 的扫描根；undefined 沿用 documentRoot，null 禁止自动扫描。 */
  uiRoot?: HTMLElement | null;
  documentTitleKey?: string;
}

/**
 * 把 Options 页面所需的插件、组件和 Element Plus 组件注册到现有 Vue app。
 *
 * 独立扩展页与 userscript 的独立设置标签页共用这一个装配入口，避免为了换挂载
 * 容器而复制一份 SettingsSections / LearningCenter 的组件注册清单。
 */
export function installOptionsApp(app: App, installOptions: OptionsAppInstallOptions = {}): void {
  app.use(createUiI18nPlugin({
    documentRoot: installOptions.documentRoot === undefined ? document.body : installOptions.documentRoot,
    documentTitleKey: installOptions.documentTitleKey ?? 'metadata.optionsTitle',
    uiRoot: installOptions.uiRoot,
  }))
  app.component('ElSelect', UiSelect)

  for (const component of ELEMENT_COMPONENTS) {
    if (component.name) app.component(component.name, component)
  }
  for (const [name, component] of Object.entries(ELEMENT_ICONS)) {
    app.component(name, component)
  }
}

/** options 的唯一组装入口：注册页面依赖后挂载 Vue 根组件。 */
export async function mountOptionsApp(selector: string): Promise<void> {
  const target = typeof window === 'undefined' ? undefined : window
  let exited = false
  const onPageHide = () => {exited = true}
  target?.addEventListener('pagehide', onPageHide)
  try {
    await configReady
    if (exited) return
    if (getConfigHydrationStatus() !== 'ready') throw new Error('Options configuration is not ready')
    let preparedLanguage: typeof config.uiLanguage | undefined
    let preparedFont: typeof config.interfaceFont | undefined
    do {
      const language = config.uiLanguage, font = config.interfaceFont
      await Promise.all([
        language === preparedLanguage ? undefined : ensureUiLanguageBundle(language),
        font === preparedFont ? undefined : prepareInterfaceFont(font),
      ])
      if (exited) return
      if (getConfigHydrationStatus() !== 'ready') throw new Error('Options configuration is not ready')
      preparedLanguage = language
      preparedFont = font
      // 资源加载期间配置可能来自其他页面；只补齐变化的资源后再显示首帧。
    } while (preparedLanguage !== config.uiLanguage || preparedFont !== config.interfaceFont)
    const app = createApp(OptionsApp)
    installOptionsApp(app)
    app.mount(selector)
  } finally {
    target?.removeEventListener('pagehide', onPageHide)
  }
}
