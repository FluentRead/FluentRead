/**
 * @file src/features/translation-stats/public.ts
 * 文件职责：提供翻译统计 feature 的稳定公开入口，让设置页面无需依赖内部 UI 文件结构即可挂载统计面板。
 * 主要内容：集中导出 TranslationStatsDashboard Vue 组件，作为 Options 设置编排层与翻译统计界面的唯一连接点。
 * 模块边界：本文件不查询统计、不访问浏览器消息或保存筛选状态；数据交互和展示逻辑均封装在 feature 内部组件与展示模型中。
 */
export {default as TranslationStatsDashboard} from './ui/TranslationStatsDashboard.vue'
