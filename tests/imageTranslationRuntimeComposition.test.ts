import {beforeEach, describe, expect, it, vi} from 'vitest';
import {customModelString} from '@/src/core/config/catalog';
import type {ImageTranslationBackgroundDependencies} from '@/src/features/image-translation/background/handlers';
import type {CompositeTranslationProvider} from '@/src/core/config/compositeTranslation';

const ports = vi.hoisted(()=>({
    config:{enableAIContext:false,service:'google',imageTranslationService:'',imageTranslationOcrEngine:'paddle',imageTranslationInferenceBackend:'auto',
        model:{} as Record<string,string>|undefined,customModel:{} as Record<string,string>|undefined,
        compositeTranslationProviders:[] as CompositeTranslationProvider[],disabledTranslationServices:[] as string[]},
    create:vi.fn(()=>[]),translate:vi.fn(),ocr:vi.fn(),offscreenFetch:vi.fn(),sourceFetch:vi.fn(),authorize:vi.fn(),progress:vi.fn(),
}));
vi.mock('@/src/services/config/store',()=>({config:ports.config}));
vi.mock('@/src/app/translation/runtime',()=>({translateWithCache:ports.translate}));
vi.mock('@/src/app/background/handlers/imageTranslation',()=>({createImageTranslationBackgroundHandlers:ports.create}));
vi.mock('@/src/features/image-translation/background/offscreenAdapter',()=>({
    imageTranslationOffscreenAdapter:{translateImage:ports.ocr,fetchImage:ports.offscreenFetch},
    imageTranslationSourceTransport:{fetchImage:ports.sourceFetch,assertImageSource:ports.authorize},
    imageTranslationProgressTransport:{sendProgress:ports.progress},
}));
import {createImageTranslationRuntime} from '@/src/app/background/imageTranslationRuntime';

beforeEach(()=>{
    vi.clearAllMocks();Object.assign(ports.config,{enableAIContext:false,service:'google',imageTranslationService:'',imageTranslationOcrEngine:'paddle',imageTranslationInferenceBackend:'auto',
        model:{},customModel:{},compositeTranslationProviders:[],disabledTranslationServices:[]});
});
function setup() {
    const languages={assertDownloaded:vi.fn(async()=>{}),getDownloaded:vi.fn(async()=>[]),markDownloaded:vi.fn(async()=>[]),markRemoved:vi.fn(async()=>[])};
    createImageTranslationRuntime(languages);
    return {languages,dependencies:(ports.create.mock.calls as unknown as [[ImageTranslationBackgroundDependencies]])[0][0]};
}
describe('图片后台依赖装配',()=>{
    it('沿用可信图片来源、OCR、进度、翻译与语言仓库端口，并跟随所选图片服务',()=>{
        const {languages,dependencies}=setup();
        expect(dependencies).toMatchObject({translateTexts:ports.translate,translateImage:ports.ocr,fetchImage:ports.sourceFetch,
            assertImageSource:ports.authorize,sendProgress:ports.progress,assertLanguagesDownloaded:languages.assertDownloaded,
            getDownloadedLanguages:languages.getDownloaded,markLanguagesDownloaded:languages.markDownloaded,markLanguagesRemoved:languages.markRemoved});
        expect(dependencies.getTranslationService()).toBe('google');ports.config.imageTranslationService='openai';
        expect(dependencies.getTranslationService()).toBe('openai');expect(dependencies.getGlossaryConfig!()).toBe(ports.config);
        expect(dependencies.getImageOcrEngine!()).toBe('paddle');ports.config.imageTranslationOcrEngine='tesseract';
        expect(dependencies.getImageOcrEngine!()).toBe('tesseract');expect(dependencies.supportsBatchTranslation('google')).toBe(true);
        expect(dependencies.getImageInferenceBackend!()).toBe('auto');ports.config.imageTranslationInferenceBackend='cpu';
        expect(dependencies.getImageInferenceBackend!()).toBe('cpu');
    });
    it('只有开启上下文的提示词型 AI 才启用邻文，专用翻译模型和机器服务不被误启用',()=>{
        const {dependencies}=setup(),enabled=dependencies.isTextContextEnabled!;
        expect(enabled('openai')).toBe(false);ports.config.enableAIContext=true;
        expect(enabled('openai')).toBe(true);expect(enabled('google')).toBe(false);
        ports.config.model={tongyi:customModelString};ports.config.customModel={tongyi:'qwen-mt-plus'};
        expect(enabled('tongyi')).toBe(false);ports.config.customModel.tongyi='qwen-plus';expect(enabled('tongyi')).toBe(true);
        ports.config.model=undefined;ports.config.customModel=undefined;expect(enabled('openai')).toBe(true);
    });
    it('组合仅由启用的 AI 成员提供上下文能力，成员关闭和全局开关立即生效',()=>{
        const {dependencies}=setup(),enabled=dependencies.isTextContextEnabled!;
        ports.config.enableAIContext=true;
        ports.config.compositeTranslationProviders=[{id:'composite:images',name:'Images',strategy:'sequential',services:['google','openai'],timeoutMs:12000}];
        expect(enabled('composite:images')).toBe(true);
        ports.config.disabledTranslationServices=['openai'];expect(enabled('composite:images')).toBe(false);
        ports.config.disabledTranslationServices=[];ports.config.enableAIContext=false;expect(enabled('composite:images')).toBe(false);
    });
});
