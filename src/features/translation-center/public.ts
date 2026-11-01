/**
 * @file src/features/translation-center/public.ts
 * 文件职责：提供翻译中心 feature 的稳定组件出口，让 Options 和原生侧边栏嵌入同一文本翻译工作台而不依赖其内部文件结构。
 * 主要内容：文件将 ui/TranslationCenter.vue 的默认导出命名为 TranslationCenter，形成清晰的 feature 级公共组件契约。
 * 模块边界：该 barrel 不创建组件实例、不读配置也不发起翻译；挂载和设置导航由 app 页面负责，翻译执行与服务能力过滤封装在组件及其依赖中。
 */
export {default as TranslationCenter} from './ui/TranslationCenter.vue';
