/**
 * @file src/features/page-notice/public.ts
 * 文件职责：提供页面通知 feature 的稳定公共出口，让全文翻译和其他内容功能可以显示通知而无需依赖 Shadow DOM 的内部结构。
 * 主要内容：导出节流错误、直接通知与按功能 key 撤销，并暴露常用翻译服务的封闭通知详情。
 * 模块边界：该 barrel 不创建 DOM、不解析消息也不打开设置；所有副作用发生在调用函数时，通知样式与节点所有权仍封装在 content 子模块。
 */
export {sendErrorMessage, showPageNotice, dismissPageNotice, showFavoriteServiceNotice} from './content/notice';
export type {PageNoticeOptions} from './content/notice';
