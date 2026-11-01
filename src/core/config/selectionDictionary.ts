/**
 * @file src/core/config/selectionDictionary.ts
 * 文件职责：定义英文划词的词典来源选项及配置归一化规则，默认保留本地优先的自动查询。
 * 主要内容：列出已接入的六种词典来源，非法或旧配置缺失的值统一回到 auto，供配置、设置界面和查询缓存共用。
 * 模块边界：只提供静态选项、类型和纯转换，不加载词库、不发出网络请求，也不依赖 feature 或浏览器。
 */
export const WORD_DICTIONARY_SOURCE_OPTIONS = [
    {value: 'auto', label: '默认（自动选择）'},
    {value: 'ecdict-local', label: 'ECDICT 本地词库'},
    {value: 'youdao-web', label: '有道词典'},
    {value: 'free-dictionary', label: 'Free Dictionary API'},
    {value: 'wiktionary-rest', label: 'Wiktionary'},
    {value: 'wiktapi', label: 'WiktApi / Wiktionary'},
    {value: 'datamuse', label: 'Datamuse'},
] as const;

export type WordDictionarySourceSetting = typeof WORD_DICTIONARY_SOURCE_OPTIONS[number]['value'];
export type WordDictionaryProviderId = Exclude<WordDictionarySourceSetting, 'auto'>;

/** 旧配置与未知来源继续使用自动策略，不能把任意地址或未来枚举当作网络来源。 */
export function normalizeWordDictionarySource(value: unknown): WordDictionarySourceSetting {
    return WORD_DICTIONARY_SOURCE_OPTIONS.some(option => option.value === value)
        ? value as WordDictionarySourceSetting : 'auto';
}
