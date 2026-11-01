/**
 * @file entrypoints/sidepanel/main.ts
 * 文件职责：启动原生侧边栏中的文本翻译页面。
 * 主要内容：将 HTML 挂载点交给 sidepanel app，由组合根处理配置准备与页面退出。
 * 模块边界：入口不读取配置、不调用供应商，也不操作网页或剪贴板。
 */
import {mountTranslationSidepanel} from '@/src/app/sidepanel';

void mountTranslationSidepanel('#app');
