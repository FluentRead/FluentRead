/**
 * @file src/app/popup/index.ts
 * 文件职责：创建 Popup Vue 应用并注册其 Element Plus 控件和图标依赖，作为 WXT popup entrypoint 与 PopupApp 之间的 composition root。
 * 主要内容：加载 popup.css、Element Plus 基础样式和共享 token，维护组件及图标清单；等待配置服务完成读取或安全降级后再创建 App，确保首帧使用已保存的皮肤、主题和布局。
 * 模块边界：这里不读取当前标签页、不保存配置，也不处理 Popup 业务事件；所有响应式交互在 PopupApp 中，feature 与 runtime 行为通过公开模块完成。
 */
import {createApp} from 'vue';
import './popup.css';
import '@/src/ui/styles/interface-skins.css';
import App from './PopupApp.vue';
import 'element-plus/dist/index.css'
import {Coffee} from '@element-plus/icons-vue'
import {ElSelect, ElOption, ElInputNumber, ElDrawer} from 'element-plus'
import {createUiI18nPlugin} from '@/src/ui/i18n'
import {configReady} from '@/src/services/config/store'

const ELEMENT_COMPONENTS = [ElSelect, ElOption, ElInputNumber, ElDrawer] as const
const ELEMENT_ICONS = {Coffee} as const

/** Popup 的唯一组装入口：配置就绪后才创建界面，避免默认布局先绘制。 */
export async function mountPopupApp(selector: string): Promise<void> {
  await configReady
  const app = createApp(App)
  app.use(createUiI18nPlugin({documentRoot: document.body, documentTitleKey: 'metadata.popupTitle'}))

  // 步骤 1：只注册 Popup 模板真正使用的 Element Plus 组件和图标。
  for (const component of ELEMENT_COMPONENTS) {
    if (component.name) app.component(component.name, component)
  }
  for (const [name, component] of Object.entries(ELEMENT_ICONS)) {
    app.component(name, component)
  }

  // 步骤 2：由唯一的 WXT 启动入口提供挂载目标，避免 app 层假定页面结构。
  app.mount(selector)
}
