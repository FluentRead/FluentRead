/**
 * @file tests/imageTargetLanguage.test.ts
 * 真实识别验证 OCR 普通文本的同目标过滤、单条与批量映射、冻结目标以及未知和混合文本的保留。
 */
import {describe, expect, it, vi} from 'vitest';
import {createImageTranslationBackgroundHandlers} from '@/src/features/image-translation/background/handlers';
import {Config} from '@/src/core/config/model';

function setup(batch: boolean, target: string) {
    const current = new Config();
    current.to = target;
    const translate = vi.fn(async (request: {origin: string | string[]; targetLanguage?: string}) =>
        Array.isArray(request.origin) ? request.origin.map(text => `T(${text})`) : `T(${request.origin})`);
    const handlers = createImageTranslationBackgroundHandlers({
        assertLanguagesDownloaded: async () => {}, translateImage: async () => ({}), fetchImage: async () => '',
        getTranslationService: () => 'microsoft', getGlossaryConfig: () => current,
        supportsBatchTranslation: () => batch, translateTexts: translate,
        downloadLanguages: async () => {}, markLanguagesDownloaded: async () => [],
    });
    const call = (texts: string[]) => handlers.find(handler => handler.type === 'fluentReadImageTranslateTexts')!
        .handle({type: 'fluentReadImageTranslateTexts', texts});
    return {current, translate, call};
}

const samples = [
    ['zh-Hans', '这个页面说明软件的功能和设置。'],
    ['zh-Hant', '這個軟體讀取文件並翻譯這個頁面上的語言。'],
    ['en', 'Welcome to the settings page.'],
    ['de', 'Dieser deutsche Absatz beschreibt die verschiedenen Einstellungen der Anwendung und die automatische Übersetzung.'],
    ['ja', 'これは日本語の説明です。'],
    ['ko', '이 페이지는 소프트웨어의 기능과 설정을 설명합니다.'],
] as const;

describe('图片 OCR 同目标源头过滤', () => {
    it.each(samples)('%s 普通 OCR 行同目标零 broker 请求', async (target, source) => {
        const {call, translate} = setup(true, target);
        await expect(call([source, source, '123', 'https://example.test']))
            .resolves.toEqual({success: true, translations: [source, source, '123', 'https://example.test']});
        expect(translate).not.toHaveBeenCalled();
    });

    it.each([true, false])('batch=%s 只提交外语行并还原重复行原索引', async batch => {
        const {call, translate} = setup(batch, 'zh-Hans');
        const chinese = samples[0][1];
        const foreign = samples[2][1];
        await expect(call([chinese, foreign, chinese, foreign, '123']))
            .resolves.toEqual({success: true, translations: [chinese, `T(${foreign})`, chinese, `T(${foreign})`, '123']});
        expect(translate).toHaveBeenCalledOnce();
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({origin: batch ? [foreign] : foreign, targetLanguage: 'zh-Hans'}));
    });

    it('目标切换后中文行发出请求，显式冻结目标覆盖后续配置变化', async () => {
        const {call, translate, current} = setup(false, 'zh-Hans');
        await call([samples[0][1]]);
        current.to = 'en';
        translate.mockImplementationOnce(async request => {current.to = 'zh-Hans'; return `T(${request.origin})`;});
        await call([samples[0][1]]);
        expect(translate).toHaveBeenCalledOnce();
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({targetLanguage: 'en'}));
    });

    it('简繁转换、真实英文句子及歧义短词仍请求', async () => {
        const {call, translate} = setup(true, 'zh-Hans');
        const texts = [samples[1][1], `${samples[0][1]} ${samples[2][1]}`, 'Settings'];
        await call(texts);
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({origin: texts}));
    });
});
