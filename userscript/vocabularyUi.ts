/**
 * @file userscript/vocabularyUi.ts
 * 文件职责：为 userscript 完整设置保留真实收藏界面，隔离没有后台支持的材料工作区。
 * 主要内容：原样重导出 VocabularyBook；材料组件只呈现现有本地化不可用说明，正常导航仍由学习中心能力门禁控制。
 * 模块边界：仅替代 vocabulary/ui/public，不改变词书、阅读历史、笔记或原文投影；不加载材料 UI、客户端或仓库，不读写学习记录。
 */
import {h} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';

export {default as VocabularyBook} from '../src/features/vocabulary/ui/VocabularyBook.vue';

export const MaterialWorkspace = {
    name: 'UserscriptMaterialWorkspaceUnavailable',
    setup() {
        const {t} = useUiI18n();
        return () => h('p', {role: 'status'}, t('options.userscriptUnavailableDescription'));
    },
};

export const loadMaterialWorkspace = () => Promise.resolve(MaterialWorkspace);
