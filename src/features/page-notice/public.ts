/**
 * @file src/features/page-notice/public.ts
 * 文件职责：提供页面通知 feature 的稳定公共出口，让全文翻译和其他内容功能可以显示通知而无需依赖 Shadow DOM 的内部结构。
 * 主要内容：文件从 content/notice 精确再导出 sendErrorMessage、showPageNotice 与 dismissPageNotice，分别覆盖节流错误提示、可指定 tone 的直接通知以及按功能 key 撤销过期反馈。
 * 模块边界：该 barrel 不创建 DOM、不解析消息也不打开设置；所有副作用发生在调用函数时，通知样式与节点所有权仍封装在 content 子模块。
 */
export {sendErrorMessage, showPageNotice, dismissPageNotice} from './content/notice';
export type {PageNoticeOptions} from './content/notice';
