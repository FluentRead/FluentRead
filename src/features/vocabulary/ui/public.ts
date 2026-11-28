/**
 * @file src/features/vocabulary/ui/public.ts
 * 文件职责：向学习中心公开词汇与原文收藏界面，同时保持领域公共入口不依赖 UI。
 * 主要内容：静态导出 VocabularyBook 组件，并通过异步加载器与异步组件入口按需拆包 MaterialWorkspace，避免学习中心首屏同步打包材料工作区。
 * 模块边界：此入口仅供 UI 组合使用；后台、服务和纯算法应使用 vocabulary/public.ts 的数据合同。
 */
import {defineAsyncComponent} from 'vue';

export {default as VocabularyBook} from './VocabularyBook.vue';
export const loadMaterialWorkspace = () => import('./MaterialWorkspace.vue').then(module => module.default);
export const MaterialWorkspace: typeof import('./MaterialWorkspace.vue').default = defineAsyncComponent(loadMaterialWorkspace);
