/**
 * @file src/core/i18n/messages/selectionDictionary.ts
 * 文件职责：维护划词词典来源设置的七语言文案。
 * 主要内容：为来源选择、默认自动策略、本地词库和单一来源查询说明提供稳定键，在线服务保留自身名称。
 * 模块边界：仅导出静态界面文本，不选择词典、不读写配置、不请求服务；扩展与 userscript 继续由既有语言资源机制消费。
 */
import type {UiLanguage} from '../types';

export const selectionDictionaryChineseMessages = {
    'selection.dictionary.source': '词典来源',
    'selection.dictionary.auto': '默认（自动选择）',
    'selection.dictionary.local': 'ECDICT 本地词库',
    'selection.dictionary.help': '默认优先使用本地词库，未命中时自动查询在线词典；指定后只查询所选词典。',
} as const;

export const selectionDictionaryMessages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>> = {
    'zh-CN': selectionDictionaryChineseMessages,
    'en-US': {
        'selection.dictionary.source': 'Dictionary source',
        'selection.dictionary.auto': 'Default (automatic)',
        'selection.dictionary.local': 'ECDICT local dictionary',
        'selection.dictionary.help': 'By default, use the local dictionary first, then online sources if needed. Selecting a source queries only that dictionary.',
    },
    'ja-JP': {
        'selection.dictionary.source': '辞書の参照先',
        'selection.dictionary.auto': '既定（自動選択）',
        'selection.dictionary.local': 'ECDICT ローカル辞書',
        'selection.dictionary.help': '既定ではローカル辞書を優先し、見つからない場合はオンライン辞書を検索します。参照先を指定すると、その辞書だけを検索します。',
    },
    'ko-KR': {
        'selection.dictionary.source': '사전 출처',
        'selection.dictionary.auto': '기본값(자동 선택)',
        'selection.dictionary.local': 'ECDICT 로컬 사전',
        'selection.dictionary.help': '기본적으로 로컬 사전을 먼저 검색하고, 없으면 온라인 사전을 검색합니다. 출처를 지정하면 해당 사전만 검색합니다.',
    },
    'fr-FR': {
        'selection.dictionary.source': 'Source du dictionnaire',
        'selection.dictionary.auto': 'Par défaut (automatique)',
        'selection.dictionary.local': 'Dictionnaire local ECDICT',
        'selection.dictionary.help': 'Par défaut, le dictionnaire local est consulté en premier, puis les sources en ligne si nécessaire. Une source choisie est la seule consultée.',
    },
    'ru-RU': {
        'selection.dictionary.source': 'Источник словаря',
        'selection.dictionary.auto': 'По умолчанию (автоматически)',
        'selection.dictionary.local': 'Локальный словарь ECDICT',
        'selection.dictionary.help': 'По умолчанию сначала используется локальный словарь, затем при необходимости онлайн-источники. При выборе источника запрос отправляется только в этот словарь.',
    },
    'es-ES': {
        'selection.dictionary.source': 'Fuente del diccionario',
        'selection.dictionary.auto': 'Predeterminado (automático)',
        'selection.dictionary.local': 'Diccionario local ECDICT',
        'selection.dictionary.help': 'De forma predeterminada se consulta primero el diccionario local y después las fuentes en línea si es necesario. Al elegir una fuente, solo se consulta ese diccionario.',
    },
};
