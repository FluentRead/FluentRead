/**
 * @file src/core/language/lexicon.ts
 *
 * 文件职责：保存统计识别使用的独立语言证据数据，为短文本和相近语言提供不依赖三元组分数的旁证与反证。
 * 主要内容：按书写体系列出各语言高频封闭类功能词（冠词、介词、代词、助词、连词等），以及 Latin、Cyrillic、Arabic 文字语言的合法附加字母或排他字母；数据只描述语言通用特征，不收录任何具体网页、品牌、模型名或用户样例整句。另收录与目录语言相近、但 franc-min 缺少模型的语言（加泰罗尼亚语、加利西亚语、南非荷兰语、新挪威语、马其顿语、白俄罗斯语、哈萨克语）作为反证。可核对的公开符号包括 FUNCTION_WORDS、LATIN_EXTRA_LETTERS、CYRILLIC_LETTERS、ARABIC_FOREIGN_LETTERS、STATISTICAL_SCRIPT_LANGUAGES。
 * 模块边界：本文件从 functionWordData.ts 读取逐字保留的功能词字符串并建立只读词集，其他正字法数据仍在此导出；不执行识别、不访问配置或浏览器；如何加权、何时视为可信由 statistical.ts 负责并通过语料测试校准。
 */

import * as functionWordData from './functionWordData';

export type StatisticalScript = 'Latin' | 'Cyrillic' | 'Arabic' | 'Devanagari';

function words(value: string): ReadonlySet<string> {
    return new Set(value.trim().split(/\s+/u));
}

/**
 * 功能词按书写体系分组，只在同一文字的候选之间比较。列表刻意保持在高频词范围：
 * 它们在正文中必然大量出现，却几乎不会出现在品牌名、界面标签或技术标识符中。
 */
export const FUNCTION_WORDS: Readonly<Record<StatisticalScript, Readonly<Record<string, ReadonlySet<string>>>>> = {
    Latin: {
        en: words(functionWordData.latinEnWords),
        fr: words(functionWordData.latinFrWords),
        de: words(functionWordData.latinDeWords),
        es: words(functionWordData.latinEsWords),
        pt: words(functionWordData.latinPtWords),
        it: words(functionWordData.latinItWords),
        nl: words(functionWordData.latinNlWords),
        pl: words(functionWordData.latinPlWords),
        cs: words(functionWordData.latinCsWords),
        sk: words(functionWordData.latinSkWords),
        ro: words(functionWordData.latinRoWords),
        hu: words(functionWordData.latinHuWords),
        tr: words(functionWordData.latinTrWords),
        vi: words(functionWordData.latinViWords),
        id: words(functionWordData.latinIdWords),
        ms: words(functionWordData.latinMsWords),
        fil: words(functionWordData.latinFilWords),
        sw: words(functionWordData.latinSwWords),
        sv: words(functionWordData.latinSvWords),
        da: words(functionWordData.latinDaWords),
        nb: words(functionWordData.latinNbWords),
        fi: words(functionWordData.latinFiWords),
        et: words(functionWordData.latinEtWords),
        lv: words(functionWordData.latinLvWords),
        lt: words(functionWordData.latinLtWords),
        sl: words(functionWordData.latinSlWords),
        hr: words(functionWordData.latinHrWords),
        bs: words(functionWordData.latinBsWords),
        'sr-Latn': words(functionWordData.latinSrLatnWords),
        // 以下语言不在翻译目录中，但与目录语言高度相近且 franc-min 没有统计模型；它们只作为反证，防止加泰罗尼亚语、加利西亚语或南非荷兰语被当成西班牙语、葡萄牙语或荷兰语跳过。
        ca: words(functionWordData.latinCaWords),
        gl: words(functionWordData.latinGlWords),
        af: words(functionWordData.latinAfWords),
        nn: words(functionWordData.latinNnWords),
    },
    Cyrillic: {
        ru: words(functionWordData.cyrillicRuWords),
        uk: words(functionWordData.cyrillicUkWords),
        bg: words(functionWordData.cyrillicBgWords),
        sr: words(functionWordData.cyrillicSrWords),
        be: words(functionWordData.cyrillicBeWords),
        kk: words(functionWordData.cyrillicKkWords),
        mk: words(functionWordData.cyrillicMkWords),
    },
    Arabic: {
        ar: words(functionWordData.arabicArWords),
        fa: words(functionWordData.arabicFaWords),
        ur: words(functionWordData.arabicUrWords),
    },
    Devanagari: {
        hi: words(functionWordData.devanagariHiWords),
        mr: words(functionWordData.devanagariMrWords),
        ne: words(functionWordData.devanagariNeWords),
    },
};

/** 各统计文字中有功能词证据、可以被识别的语言；目录外语言即使被识别也不会匹配任何目标语言。 */
export const STATISTICAL_SCRIPT_LANGUAGES: Readonly<Record<StatisticalScript, readonly string[]>> = {
    Latin: Object.keys(FUNCTION_WORDS.Latin),
    Cyrillic: Object.keys(FUNCTION_WORDS.Cyrillic),
    Arabic: Object.keys(FUNCTION_WORDS.Arabic),
    Devanagari: Object.keys(FUNCTION_WORDS.Devanagari),
};

/** Latin 文字语言在 ASCII 字母之外正常使用的字母，每个功能词语言都必须有条目；出现清单外字母是该语言结论的反证。 */
export const LATIN_EXTRA_LETTERS: Readonly<Record<string, string>> = {
    en: '', fr: 'àâæçéèêëîïôœùûüÿ', de: 'äöüß', es: 'áéíóúüñ', pt: 'áàâãçéêíóôõú', it: 'àèéìíîòóùú',
    nl: 'áäéëïóöüè', pl: 'ąćęłńóśźż', cs: 'áčďéěíňóřšťúůýž', sk: 'áäčďéíĺľňóôŕšťúýž', ro: 'ăâîșțşţ',
    hu: 'áéíóöőúüű', tr: 'çğıöşüâîû', vi: 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    id: 'é', ms: '', fil: 'ñ', sw: '', sv: 'åäöé', da: 'æøåé', nb: 'æøåéóòô', fi: 'äöåšž', et: 'äöüõšž',
    lv: 'āčēģīķļņšūž', lt: 'ąčęėįšųūž', sl: 'čšžćđ', hr: 'čćđšž', bs: 'čćđšž', 'sr-Latn': 'čćđšž',
    ca: 'àçèéíïòóúü·', gl: 'áéíñóúü', af: 'áéèêëíîïóôöúûü', nn: 'æøåéóòô',
};

/** Cyrillic 文字语言的完整小写字母表；清单外字母（如乌克兰文 ї 出现在俄文候选中）构成反证。 */
export const CYRILLIC_LETTERS: Readonly<Record<string, string>> = {
    ru: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
    uk: 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя',
    bg: 'абвгдежзийклмнопрстуфхцчшщъьюяѝ',
    sr: 'абвгдђежзијклљмнњопрстћуфхцчџш',
    be: 'абвгдеёжзійклмнопрстуўфхцчшыьэюя',
    kk: 'аәбвгғдеёжзийкқлмнңоөпрстуұүфхһцчшщъыіьэюя',
    mk: 'абвгдѓежзѕијклљмнњопрстќуфхцчџш',
};

/** Arabic 文字语言中属于其他语言正字法的字母；阿拉伯文键盘输入的 ي/ك 在波斯文和乌尔都文中常见，不作反证。 */
export const ARABIC_FOREIGN_LETTERS: Readonly<Record<string, string>> = {
    ar: 'پچژگیکٹڈڑںےہھ',
    fa: 'ٹڈڑںےہھة',
    ur: 'ة',
};
