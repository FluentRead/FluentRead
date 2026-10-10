/**
 * @file tests/languageStatistical.test.ts
 * 统计识别证据链使用真实 franc-min：短文本/长文本、决定性功能词、分差达标、功能词中性、franc 平局打破、
 * 统计模型缺失语言的功能词专用路径，以及正字法反证、功能词矛盾、不支持语言和过短文本的拒绝分支。
 * 同时核对 franc-min 模型清单与功能词数据的一致性，防止依赖升级或数据编辑悄悄改变判断前提。
 */
import {describe, expect, it, vi} from 'vitest';
import {data as francMinData} from 'franc-min/data.js';
import {translationLanguageOptions} from '@/src/core/language/catalog';
import {
    ARABIC_FOREIGN_LETTERS,
    CYRILLIC_LETTERS,
    FUNCTION_WORDS,
    LATIN_EXTRA_LETTERS,
    STATISTICAL_SCRIPT_LANGUAGES,
    type StatisticalScript,
} from '@/src/core/language/lexicon';
import {FRANC_MIN_LANGUAGES, STATISTICAL_THRESHOLDS, assessStatisticalLanguage} from '@/src/core/language/statistical';

const rankOverride = vi.hoisted(() => ({value: undefined as Array<[string, number]> | undefined}));
vi.mock('franc-min', async importOriginal => {
    const actual = await importOriginal<typeof import('franc-min')>();
    return {...actual, francAll: (...args: Parameters<typeof actual.francAll>) => rankOverride.value ?? actual.francAll(...args)};
});

function words(text: string): string[] {
    return text.match(/[\p{L}\p{M}'’]+/gu) ?? [];
}

function assess(script: StatisticalScript, text: string) {
    return assessStatisticalLanguage(script, words(text));
}

describe('数据前提', () => {
    it('franc-min 模型清单与依赖数据逐项一致', () => {
        for (const script of ['Latin', 'Cyrillic', 'Arabic', 'Devanagari'] as const) {
            expect([...FRANC_MIN_LANGUAGES[script]].sort()).toEqual(Object.keys(francMinData[script]).sort());
        }
    });

    it('功能词均为小写、NFC、无空词，且目录中的统计文字语言都有功能词证据', () => {
        const catalog = new Set(translationLanguageOptions.map(option => option.value));
        for (const [script, lexicons] of Object.entries(FUNCTION_WORDS)) {
            for (const [language, lexicon] of Object.entries(lexicons)) {
                expect(lexicon.size, `${script}/${language}`).toBeGreaterThanOrEqual(15);
                for (const word of lexicon) {
                    expect(word).toBe(word.normalize('NFC').toLocaleLowerCase());
                    expect(word.trim()).toBe(word);
                    expect(word).not.toBe('');
                }
            }
        }
        for (const language of ['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'pl', 'cs', 'sk', 'ro', 'hu', 'tr', 'vi', 'id', 'ms', 'fil', 'sw',
            'sv', 'da', 'nb', 'fi', 'et', 'lv', 'lt', 'sl', 'hr']) {
            expect(catalog.has(language)).toBe(true);
            expect(STATISTICAL_SCRIPT_LANGUAGES.Latin).toContain(language);
            expect(LATIN_EXTRA_LETTERS[language]).toBeTypeOf('string');
        }
        const orthography = {Latin: LATIN_EXTRA_LETTERS, Cyrillic: CYRILLIC_LETTERS, Arabic: ARABIC_FOREIGN_LETTERS} as const;
        for (const [script, data] of Object.entries(orthography)) {
            expect(Object.keys(data).sort(), script).toEqual(Object.keys(FUNCTION_WORDS[script as keyof typeof orthography]).sort());
        }
        for (const language of ['hi', 'mr', 'ne']) expect(STATISTICAL_SCRIPT_LANGUAGES.Devanagari).toContain(language);
    });

    it('阈值对象不可变，避免运行时被调用方改写', () => {
        expect(Object.isFrozen(STATISTICAL_THRESHOLDS)).toBe(true);
    });
});

describe('可信路径', () => {
    it('统计判断不随宿主默认土耳其语大小写规则改变', () => {
        const text = 'THIS IS THE ORIGINAL TEXT IN THIS PARAGRAPH AND IT IS WRITTEN IN ENGLISH.';
        const expected = assess('Latin', text);
        expect(expected.language).toBe('en');
        const lower = String.prototype.toLocaleLowerCase;
        const hostLocale = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function(this: string) {
            return lower.call(this, 'tr');
        });
        try {
            expect(assess('Latin', text)).toEqual(expected);
        } finally {
            hostLocale.mockRestore();
        }
    });

    it.each([
        ['Latin', 'This paragraph explains how the translation extension keeps the original text and shows the translated sentence below it.', 'en'],
        ['Latin', 'Le fichier est introuvable sur le serveur.', 'fr'],
        ['Latin', 'Este programa permite traducir documentos y páginas de internet del español a otros idiomas.', 'es'],
        ['Cyrillic', 'Этот абзац объясняет, как расширение сохраняет исходный текст и показывает перевод прямо под ним.', 'ru'],
        ['Devanagari', 'हमारी वेबसाइट पर आपका स्वागत है।', 'hi'],
        ['Arabic', 'يہ پیراگراف وضاحت کرتا ہے کہ ایکسٹینشن اصل متن کو کیسے محفوظ رکھتی ہے اور ترجمہ اس کے بالکل نیچے دکھاتی ہے۔', 'ur'],
    ] as const)('功能词决定性领先：%s', (script, text, language) => {
        expect(assess(script, text)).toMatchObject({language, reason: 'decisive'});
    });

    it('功能词严格领先且分差达标：英文短句', () => {
        expect(assess('Latin', 'Welcome to the settings page.')).toMatchObject({language: 'en', reason: 'supported'});
    });

    it('功能词与相近语言持平时要求更大分差：俄文短句', () => {
        const result = assess('Cyrillic', 'Добро пожаловать на наш сайт.');
        expect(result).toMatchObject({language: 'ru', reason: 'neutral'});
        expect(result.functionWordScores.uk).toBe(result.functionWordScores.ru);
    });

    it('franc 以极小分差排错时，由决定性功能词打破平局：意大利语不被当成西班牙语', () => {
        const result = assess('Latin', "Questo paragrafo spiega come l'estensione mantiene il testo originale e mostra la traduzione subito sotto.");
        expect(result.candidates[0]!.language).toBe('es');
        expect(result).toMatchObject({language: 'it', reason: 'near-tie'});
    });

    it.each([
        ['Aktualizovali sme zásady ochrany súkromia, aby sme vysvetlili, ktoré nastavenia sa ukladajú vo vašom zariadení.', 'sk'],
        ['Šajā rindkopā ir paskaidrots, kā paplašinājums saglabā sākotnējo tekstu un parāda tulkojumu tieši zem tā.', 'lv'],
        ['See lõik selgitab, kuidas laiendus säilitab algse teksti ja näitab tõlget otse selle all.', 'et'],
    ])('franc-min 没有模型的目录语言只接受决定性功能词：%s', (text, language) => {
        const result = assess('Latin', text);
        expect(result.candidates.some(candidate => candidate.language === language)).toBe(false);
        expect(result).toMatchObject({language, reason: 'lexical-only'});
    });
});

describe('保留翻译机会的拒绝分支', () => {
    it.each([
        ['Settings'], ['Hallo Welt.'], ['¿Cómo estás?'], ['Save'],
    ])('单词或少于十个字母：%s', (text) => {
        expect(assess('Latin', text)).toMatchObject({reason: 'too-short'});
        expect(assess('Latin', text).language).toBeUndefined();
    });

    it('首位语言违反字母表时不采信：带乌尔都文字母的文本不能被当成波斯文', () => {
        const result = assess('Arabic', 'ہماری ویب سائٹ پر خوش آمدید۔');
        expect(result.candidates[0]!.language).toBe('fa');
        expect(result.reason).toBe('orthography');
        expect(result.language).toBeUndefined();
    });

    it('其他语言功能词占优时不采信 franc 首位：西班牙语短句被 franc 排为葡萄牙语', () => {
        const result = assess('Latin', 'Bienvenido a nuestro sitio web.');
        expect(result.candidates[0]!.language).toBe('pt');
        expect(result.reason).toBe('function-words');
        expect(result.language).toBeUndefined();
    });

    it('相近语言功能词并列且分差不足时不跳过：印尼语与马来语', () => {
        expect(assess('Latin', 'Selamat datang ke laman web kami.').language).toBeUndefined();
        expect(assess('Latin', 'Paragraf ini menjelaskan bagaimana ekstensi mempertahankan teks asli dan menampilkan terjemahan tepat di bawahnya.').language).toBeUndefined();
    });

    it('目录外或无功能词证据的 franc 首位不作为结论', () => {
        const gibberish = assess('Latin', 'asdkjh qwe zxcvbnm plokij');
        expect(gibberish.reason).toBe('unsupported');
        expect(gibberish.language).toBeUndefined();
        expect(assess('Latin', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.').language).toBeUndefined();
    });

    it('相近目录外语言的功能词作为反证：加泰罗尼亚语与南非荷兰语', () => {
        expect(assess('Latin', 'Ahir vaig provar la nova actualització i funciona molt millor que la versió anterior.').language).not.toBe('es');
        expect(assess('Latin', 'Ek het gister die nuwe opdatering probeer en dit werk baie beter as die ou weergawe.').language).not.toBe('nl');
    });

    it('长文本字母表反证按比例容忍少量外来词，超过比例仍拒绝', () => {
        const english = 'This paragraph explains how the translation extension keeps the original text and shows the translated sentence below it.';
        expect(assess('Latin', `${english} Café.`).language).toBe('en');
        expect(assess('Latin', `${english} Çàfé ñüñ ẞøå.`).language).toBeUndefined();
    });

    it('功能词领先语言作为逐句混合检测的旁证，即使整句不够跳过', () => {
        expect(assess('Latin', 'Welcome to our website.').functionWordLeader).toBe('en');
        expect(assess('Latin', 'Hello world').functionWordLeader).toBeUndefined();
    });

    it('文本为空时没有候选也不会抛错', () => {
        expect(assessStatisticalLanguage('Latin', [])).toMatchObject({candidates: [], reason: 'too-short', bestGuess: undefined});
    });
});

describe('模型排序与强功能词旁证', () => {
    const english = 'You can close the browser after your changes have been saved.';

    it('真实模型把普通英语排为德语时，六种英语功能词与零种德语功能词纠正近邻排序', () => {
        const result = assess('Latin', english);
        expect(result.candidates.slice(0, 2).map(candidate => candidate.language)).toEqual(['de', 'en']);
        expect(result.functionWordScores.de).toBe(0);
        expect(result).toMatchObject({language: 'en', reason: 'lexical-correction'});
        expect(assess('Latin', `${english} ${english}`)).toMatchObject({language: 'en'});
    });

    // 控制依赖的候选排序以验证防御边界；正文仍为完整自然语言，功能词与字母表使用真实数据。
    // 检查模型缺项或明显不同的排序时能保留翻译，不能为了修正一个英语例子任意提升词典候选。
    it.each([
        ['目录候选缺失', english, [['deu', 1], ['fra', 0.96], ['nld', 0.8]]],
        ['目录候选落在第三位', english, [['deu', 1], ['fra', 0.97], ['eng', 0.96]]],
        ['共享词证据不足', 'Ik kan in een huis aan de rand van het dorp wonen.', [['deu', 1], ['nld', 0.96], ['fra', 0.8]]],
        ['主模型已有本语言功能词', 'You can close the browser after your changes have been saved, sagte ich.', [['deu', 1], ['eng', 0.96], ['fra', 0.8]]],
        ['统计候选远离第一位', english, [['deu', 1], ['eng', 0.7], ['fra', 0.6]]],
        ['跨语言字母提供反证', `${english} Ça va très bien. À bientôt.`, [['deu', 1], ['eng', 0.96], ['fra', 0.8]]],
    ] as const)('%s时保留翻译机会', (_label, text, candidates) => {
        rankOverride.value = candidates.map(([code, score]) => [code, score] as [string, number]);
        try {
            expect(assess('Latin', text).language).toBeUndefined();
        } finally {
            rankOverride.value = undefined;
        }
    });
});
