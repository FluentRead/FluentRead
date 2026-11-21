/**
 * @file src/app/document-translation/glossaryCopy.ts
 * 文件职责：定义文档工作台术语候选界面专用文案。
 * 主要内容：明确提取、人工复核、术语库语言范围、保存和定向重译状态；简体中文之外使用英文。
 * 模块边界：仅由工作台加载，不进入网页翻译或 userscript 的共享语言包。
 */
import {normalizeUiLanguage} from '@/src/core/i18n/language';

const chinese = {
    title: '术语候选',
    back: '返回设置',
    extract: '提取术语候选',
    empty: '没有发现有明确定义的英文缩写或重复专名。',
    suggesting: '正在生成建议译法…',
    suggestionUnavailable: '建议译法暂不可用，可以手动填写。',
    destination: '加入术语库',
    newLibrary: '新建语言术语库',
    libraryName: '文档术语',
    anyLanguage: '任意',
    target: '建议译法',
    apply: '确认加入并重译相关段落',
    enableAndApply: '启用术语库并重译相关段落',
    effects: '成功重译会替换命中段落的译文和校订。',
    settingsChanged: '请先按当前语言和翻译设置更新译文，再应用新术语。',
    changedAfterSave: '词条已保存。翻译设置已变化，请核对后再翻译。',
    library: '该术语库的范围已变化，请重新选择。',
    capacity: '术语库容量已满，请选择另一个术语库或先清理现有词条。',
    entry: '请检查选中词条的译法，并移除重复词条。',
    saveFailed: '未能保存词条。请重新检查术语库后重试。',
    retry: '继续术语重译',
    saved: '术语已保存。',
};
const english: typeof chinese = {
    title: 'Glossary candidates',
    back: 'Back to settings',
    extract: 'Find glossary candidates',
    empty: 'No defined English abbreviations or recurring proper names were found.',
    suggesting: 'Suggesting translations…',
    suggestionUnavailable: 'Suggestions are unavailable. You can enter translations manually.',
    destination: 'Glossary to update',
    newLibrary: 'Create a language glossary',
    libraryName: 'Document terms',
    anyLanguage: 'Any',
    target: 'Suggested translation',
    apply: 'Add terms and retranslate matching paragraphs',
    enableAndApply: 'Enable glossaries and retranslate matching paragraphs',
    effects: 'A successful retranslation replaces the translation and edits in matching paragraphs.',
    settingsChanged: 'Update this translation with the current language and service settings before applying new terms.',
    changedAfterSave: 'Terms were saved. Review the updated translation settings before translating.',
    library: 'The glossary scope has changed. Choose a glossary again.',
    capacity: 'The glossary limit was reached. Choose another glossary or remove existing entries.',
    entry: 'Check the selected translations and remove duplicate terms.',
    saveFailed: 'The terms could not be saved. Check the glossary and retry.',
    retry: 'Resume glossary retranslation',
    saved: 'Terms saved.',
};

export function getDocumentGlossaryCopy(language: string) {
    return normalizeUiLanguage(language) === 'zh-CN' ? chinese : english;
}
