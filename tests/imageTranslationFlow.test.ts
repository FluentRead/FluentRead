import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {translate, translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {createImageTranslationBackgroundHandlers, IMAGE_TRANSLATE_MESSAGE_TYPE, IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, IMAGE_CANCEL_MESSAGE_TYPE} from '@/src/features/image-translation/background/handlers';
import {IMAGE_PROGRESS_MESSAGE_TYPE, isImageTranslationStage, normalizeImageProgress} from '@/src/features/image-translation/progress';
import {createOpenOptionsPageHandler} from '@/src/features/settings/background';
import {IMAGE_LOCAL_FAILURES, imageLocalFailureMessage, imageTranslationFailureCode, imageTranslationFailureResponse, createImageTranslationFailure} from '@/src/features/image-translation/failure';
import {createImageControls} from '@/src/features/image-translation/content/controls';
import {IMAGE_READER_CSS} from '@/src/features/image-translation/content/textReader';
import {sendCancellableImageOperation, prepareImageOcrLanguages} from '@/src/features/image-translation/services/client';
import {imageTranslationProgressTransport} from '@/src/features/image-translation/background/offscreenAdapter';
import {getTranslationRequestControl, attachTranslationGlossaryContext} from '@/src/services/translation/requestSnapshot';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

const deferred = <T>() => {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r,j) => {resolve=r;reject=j;}); return {promise,resolve,reject};};
function setup(extra = {}) {
    const dependencies = {assertLanguagesDownloaded: vi.fn(async()=>{}), translateImage:vi.fn(async()=>({image:'data:image/png,x',lines:[]})),fetchImage:vi.fn(async()=>''),getTranslationService:()=> 'google',supportsBatchTranslation:()=>false,translateTexts:vi.fn(async(request:{origin:string|string[]})=>`译:${request.origin}`),downloadLanguages:vi.fn(async()=>{}),markLanguagesDownloaded:vi.fn(async()=>[]), ...extra};
    const handlers=createImageTranslationBackgroundHandlers(dependencies);
    return {dependencies, handler:(type:string)=>handlers.find(h=>h.type===type)!};
}
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function mockProgressClient(sendMessage: ReturnType<typeof vi.fn>) {
    const listeners = new Set<(value: unknown) => void>();
    const addListener = vi.fn((listener: (value: unknown) => void) => listeners.add(listener));
    const removeListener = vi.fn((listener: (value: unknown) => void) => listeners.delete(listener));
    vi.stubGlobal('browser', {runtime: {sendMessage, onMessage: {addListener, removeListener}}});
    return {listeners, addListener, removeListener};
}

describe('图片失败恢复和控件可见性', () => {
    it('模型入口定位到本地服务编辑区，拒绝无效服务与错误分区', async () => {
        const openSection=vi.fn(async()=>{}),openDefaultPage=vi.fn(async()=>{});
        const handler=createOpenOptionsPageHandler({openSection,openDefaultPage});
        await handler.handle({type:'openOptionsPage',section:'settings-services',service:'localTranslation'});
        expect(openSection).toHaveBeenCalledWith('settings-services','localTranslation');expect(openDefaultPage).not.toHaveBeenCalled();
        for (const request of [{section:'settings-services',service:'invalid'},{section:'settings-services',service:2},{section:'settings-image-translation',service:'localTranslation'}]) {
            await expect(handler.handle({type:'openOptionsPage',...request})).rejects.toThrow('无效');
        }
    });

    it('本地错误通过文本后台、Offscreen 和整图后台保留原因，未知错误不冒充模型问题', async () => {
        for (const code of IMAGE_LOCAL_FAILURES) {
            const key = code === 'failed' ? 'settings.localTranslation.trialError' : `settings.localTranslation.error.${code}`;
            const {handler} = setup({translateTexts: vi.fn(async () => {throw Object.assign(new Error('localized provider error'), {localTranslationErrorKey: key});})});
            const response = await handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['Hello']});
            expect(response).toMatchObject({success: false, errorCode: code});
            const offscreenError = createImageTranslationFailure('wrapped error', response);
            const whole = setup({translateImage: vi.fn(async () => {throw offscreenError;})});
            expect(await whole.handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_MESSAGE_TYPE, image: 'data:image/png,x', sourceLanguage: 'en'}))
                .toEqual(imageTranslationFailureResponse(offscreenError));
            expect(imageTranslationFailureCode(offscreenError)).toBe(code);
            for (const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES'] as UiLanguage[]) {
                expect(translateLegacyText(imageLocalFailureMessage(code), language)).not.toBe(imageLocalFailureMessage(code));
            }
        }
        for (const value of [null, 'language', {}, {errorCode: 'unexpected'}, {localTranslationErrorKey: 'other.language'}, {localTranslationErrorKey: 'settings.localTranslation.error.invalid'}]) {
            expect(imageTranslationFailureCode(value)).toBeUndefined();
            expect(createImageTranslationFailure('unknown', value)).not.toHaveProperty('errorCode');
        }
        expect(imageTranslationFailureResponse('offline')).toEqual({success:false,error:'offline'});
    });

    it('短词借助同图文字，明确语言的正文和非本地服务不使用这段判断上下文', async () => {
        const texts = ['Hype', 'Quality', 'This is a long enough English sentence for reliable language detection.'];
        const local = setup({getTranslationService: () => 'localTranslation'});
        await local.handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts, title: '页面标题不属于图片'});
        const requests = local.dependencies.translateTexts.mock.calls.map(call => call[0] as any);
        expect(requests.find(request => request.origin === 'Quality').sourceLanguageDetectionText).toBe(texts.join('\n'));
        expect(requests.find(request => request.origin === texts[2])).not.toHaveProperty('sourceLanguageDetectionText');
        const mixed = setup({getTranslationService: () => 'localTranslation'});
        await mixed.handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['Quality','这是图片里的中文介绍，需要保留其中的英文短词。']});
        for (const call of mixed.dependencies.translateTexts.mock.calls) expect(call[0]).not.toHaveProperty('sourceLanguageDetectionText');
        const remote = setup();
        await remote.handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts});
        for (const call of remote.dependencies.translateTexts.mock.calls) expect(call[0]).not.toHaveProperty('sourceLanguageDetectionText');
    });

    it('模型/服务导航拒绝合成点击，离开译图隐藏并保留键盘焦点和文字面板', () => {
        const {document,window} = parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
        const onSettings = vi.fn();
        const ui = createImageControls({onAction(){},onPrepare(){},onSettings});document.body.append(ui.element,ui.feedback);
        const click = (target: Element, trusted = true) => {const event = new window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:trusted});target.dispatchEvent(event);};
        ui.update('error',imageLocalFailureMessage('language'),{modelSettings:true,serviceSettings:true,errorDetails:'original failure'});
        const model = ui.feedback.querySelector<HTMLButtonElement>('.fr-image-model-settings')!;
        const service = ui.feedback.querySelector<HTMLButtonElement>('.fr-image-service-settings')!;
        click(model,false);expect(onSettings).not.toHaveBeenCalled();click(model);click(service);
        expect(onSettings.mock.calls).toEqual([['settings-services'],['settings-image-translation']]);
        ui.setLines([{text:'译文',sourceText:'Source'}]);ui.update('translated','完成');ui.setHovered(false);
        expect(ui.element.hidden).toBe(true);ui.setHovered(true);expect(ui.element.hidden).toBe(false);
        vi.spyOn(ui.button,'matches').mockImplementation(selector => selector === ':focus-visible');
        ui.button.dispatchEvent(new window.Event('focusin',{bubbles:true}));ui.setHovered(false);expect(ui.element.hidden).toBe(false);
        for (const target of [ui.button,ui.reader,document.body]) {
            if (target !== document.body) vi.spyOn(target,'matches').mockImplementation(selector => selector === ':focus-visible');
            const event = new window.Event('focusout',{bubbles:true});Object.defineProperty(event,'relatedTarget',{value:target});
            ui.button.dispatchEvent(event);expect(ui.element.hidden).toBe(target === document.body);
        }
        ui.button.dispatchEvent(new window.Event('focusout',{bubbles:true}));expect(ui.element.hidden).toBe(true);
        ui.setHovered(true);click(ui.element.querySelector<HTMLButtonElement>('[aria-expanded]')!);ui.setHovered(false);expect(ui.element.hidden).toBe(false);
        ui.hideReader();expect(ui.element.hidden).toBe(true);ui.dispose();click(model);expect(onSettings).toHaveBeenCalledTimes(2);
    });
});

it('键盘焦点在操作条与文字面板之间转移后继续保留入口，离开二者才隐藏', () => {
    const {document, window} = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document);
    const ui = createImageControls({onAction(){}, onPrepare(){}});
    document.body.append(ui.element, ui.feedback);
    ui.setLines([{text:'译文'}]); ui.update('translated','已翻译'); ui.setHovered(false);
    expect(ui.element.hidden).toBe(true);
    const readerButton = ui.reader.querySelector('button')!;
    vi.spyOn(ui.button, 'matches').mockImplementation(selector => selector === ':focus-visible');
    vi.spyOn(readerButton, 'matches').mockImplementation(selector => selector === ':focus-visible');
    const moveFocus = (relatedTarget: Element | null) => {
        const event = new window.Event('focusout', {bubbles: true});
        Object.defineProperty(event,'relatedTarget',{value: relatedTarget}); ui.button.dispatchEvent(event);
    };
    moveFocus(ui.button); expect(ui.element.hidden).toBe(false);
    moveFocus(readerButton); expect(ui.element.hidden).toBe(false);
    moveFocus(document.body); expect(ui.element.hidden).toBe(true);
    moveFocus(null); expect(ui.element.hidden).toBe(true);
    ui.dispose();
});

describe('图片翻译流程优化',()=>{
    it.each(['ru', 'ko-KR'])('漫画 %s 先核对语言包，继续携带漫画模式且不采用单图引擎设置', async sourceLanguage => {
        const {handler, dependencies} = setup({getImageOcrEngine: () => 'paddle'});
        const message = {type: IMAGE_TRANSLATE_MESSAGE_TYPE, image: 'data:image/png,x', sourceLanguage, manga: true};
        await handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle(message);
        expect(dependencies.assertLanguagesDownloaded).toHaveBeenCalledWith(sourceLanguage);
        expect(dependencies.translateImage).toHaveBeenCalledWith(message.image, sourceLanguage, '', expect.objectContaining({manga: true}));
        dependencies.translateImage.mockClear();
        dependencies.assertLanguagesDownloaded.mockRejectedValueOnce(new Error('missing language'));
        await expect(handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle(message)).rejects.toThrow('missing language');
        expect(dependencies.translateImage).not.toHaveBeenCalled();
        expect(dependencies.downloadLanguages).not.toHaveBeenCalled();
    });
    it('专用漫画路径跳过 Tesseract 包预检，模型管理沿用后台消息',async()=>{
        const getMangaModelStatus=vi.fn(async()=>({ready:true,bytes:123,inpaintingReady:false})),removeMangaModels=vi.fn(async()=>{});
        const {handler,dependencies}=setup({getMangaModelStatus,removeMangaModels});
        expect(await handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle({type:IMAGE_TRANSLATE_MESSAGE_TYPE,image:'data:image/png,x',sourceLanguage:'en',manga:true})).toMatchObject({success:true});
        expect(dependencies.assertLanguagesDownloaded).not.toHaveBeenCalled();
        expect(dependencies.translateImage).toHaveBeenCalledWith('data:image/png,x','en','',expect.objectContaining({manga:true}));
        expect(await handler('fluentReadMangaModelStatus').handle({type:'fluentReadMangaModelStatus'})).toEqual({success:true,ready:true,bytes:123,inpaintingReady:false});
        expect(await handler('fluentReadMangaModelRemove').handle({type:'fluentReadMangaModelRemove'})).toEqual({success:true});expect(removeMangaModels).toHaveBeenCalledOnce();
        await expect(handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle({type:IMAGE_TRANSLATE_MESSAGE_TYPE,image:'data:image/png,x',sourceLanguage:'en',manga:'true'} as never)).rejects.toThrow('漫画翻译模式无效');
    });
    it('识别进度接受有效百分比，语言刷新保留数值，完成或失败清除百分比', () => {
        for (const invalid of [undefined, null, '50', NaN, Infinity, -1, 101]) expect(normalizeImageProgress(invalid)).toBeUndefined();
        expect(normalizeImageProgress(0)).toBe(0); expect(normalizeImageProgress(100)).toBe(100);
        const {document} = parseHTML('<html><body></body></html>'); vi.stubGlobal('document', document);
        let language: UiLanguage = 'en-US';
        const ui = createImageControls({onAction(){},onPrepare(){},translate:source=>translateLegacyText(source,language)});
        ui.update('loading','正在识别图片文字…',{progress:42.9});
        expect(ui.status.textContent).toContain('42%');
        language='ja-JP';ui.refreshLanguage();expect(ui.status.textContent).toContain('42%');
        ui.update('loading','正在翻译文字…');expect(ui.status.textContent).not.toContain('%');
        ui.update('error','识别失败',{progress:42});expect(ui.status.textContent).not.toContain('%');
        ui.dispose();
    });

    it('漫画处理显示轻量进度，失败才在所属图片边缘提供恢复动作，完成和原图撤下', () => {
        const {document} = parseHTML('<html><body></body></html>');vi.stubGlobal('document', document);
        const ui = createImageControls({onAction(){},onPrepare(){}});
        ui.update('loading', '正在识别图片文字…', {quiet:true, progress:42});
        expect(ui.feedback.hidden).toBe(false);expect(ui.element.hidden).toBe(true);
        expect(ui.element.getAttribute('aria-busy')).toBe('true');expect(ui.status.textContent).toContain('42%');
        const bar=ui.feedback.querySelector<HTMLElement>('[role=progressbar]')!;
        expect(bar.hidden).toBe(false);expect(bar.getAttribute('aria-valuenow')).toBe('42');
        ui.update('loading','正在翻译文字…',{quiet:true});expect(ui.feedback.hidden).toBe(false);
        expect(bar.hidden).toBe(true);expect(bar.getAttribute('aria-valuenow')).toBeNull();expect(ui.status.textContent).not.toContain('%');
        ui.update('error', '翻译失败', {quiet:true});
        expect(ui.feedback.hidden).toBe(false);expect(ui.element.hidden).toBe(true);
        expect(ui.button.parentElement!.parentElement).toBe(ui.feedback);expect(ui.button.textContent).toBe('重试');
        expect(ui.feedback.querySelector<HTMLElement>('.fr-image-feedback-title')!.hidden).toBe(true);
        ui.setLines([{text:'译文'}]);ui.update('translated', '查看译图', {quiet:true});expect(ui.element.hidden).toBe(true);expect(ui.feedback.hidden).toBe(true);
        ui.update('idle','查看译图',{quiet:true});expect(ui.feedback.hidden).toBe(true);expect(ui.element.hidden).toBe(true);
        ui.update('loading', '正在读取图片…');expect(ui.feedback.hidden).toBe(false);expect(ui.element.hidden).toBe(false);
        expect(ui.button.parentElement!.parentElement).toBe(ui.element);expect(ui.feedback.querySelector('button')).toBeNull();ui.dispose();
    });

    it('漫画单页排队时提供取消操作，开始处理后恢复普通轻量进度', () => {
        const {document} = parseHTML('<html><body></body></html>');vi.stubGlobal('document', document);
        const ui = createImageControls({onAction(){},onPrepare(){},translate:source=>translateLegacyText(source,'en-US')});
        ui.update('loading', '等待上一项任务结束…', {quiet:true, queued:true});
        expect(ui.feedback.hidden).toBe(false);expect(ui.feedback.dataset.queued).toBe('true');
        expect(ui.status.textContent).toBe('Waiting for the previous task…');
        expect(ui.button.parentElement!.parentElement).toBe(ui.feedback);expect(ui.button.textContent).toBe('Cancel');
        ui.update('loading', '正在识别图片文字…', {quiet:true});
        expect(ui.feedback.dataset.queued).toBe('false');expect(ui.feedback.querySelector('button')).toBeNull();
        expect(ui.button.parentElement!.parentElement).toBe(ui.element);ui.dispose();
    });

    it('漫画错误恢复保留详情、键盘和设置入口，拒绝合成动作且不触发宿主翻页快捷键', () => {
        const {document,window} = parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
        const onAction=vi.fn(),onDismiss=vi.fn(),onSettings=vi.fn();
        const ui=createImageControls({onAction,onDismiss,onSettings,onPrepare(){}});document.body.append(ui.feedback,ui.element);
        ui.update('error','翻译服务暂时不可用',{quiet:true,modelSettings:true,serviceSettings:true,errorDetails:'精确错误详情'});
        const details=ui.feedback.querySelector<HTMLDetailsElement>('details')!;
        expect(details.hidden).toBe(false);expect(details.textContent).toContain('精确错误详情');expect(details.open).toBe(false);
        const hostInput=vi.fn();
        for(const type of ['click','pointerdown','keydown','keyup','wheel']) {
            document.body.addEventListener(type,hostInput);
            details.querySelector('summary')!.dispatchEvent(new window.Event(type,{bubbles:true}));
            expect(hostInput).not.toHaveBeenCalled();
        }
        const click=(target:Element,trusted:boolean)=>{const event=new window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:trusted});target.dispatchEvent(event);};
        click(ui.button,false);expect(onAction).not.toHaveBeenCalled();click(ui.button,true);expect(onAction).toHaveBeenCalledOnce();
        const service=ui.feedback.querySelector<HTMLButtonElement>('.fr-image-service-settings')!;
        expect(service.hidden).toBe(false);click(service,true);expect(onSettings).toHaveBeenCalledWith('settings-image-translation');
        click(ui.dismiss,true);expect(onDismiss).toHaveBeenCalledOnce();expect(hostInput).not.toHaveBeenCalled();
        ui.update('idle','翻译图片',{quiet:true});expect(ui.feedback.hidden).toBe(true);
        const orphan=document.createElement('div');orphan.append(ui.feedback);document.body.append(orphan);ui.dispose();
        orphan.append(ui.feedback);details.querySelector('summary')!.dispatchEvent(new window.Event('keydown',{bubbles:true}));
        expect(hostInput).toHaveBeenCalledOnce();
    });

    it.each([true,false])('展开长错误详情时恢复动作先进入键盘顺序，详情与本地化更新不挤走恢复入口：quiet=%s', quiet => {
        const {document}=parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
        const action=vi.fn(),ui=createImageControls({onAction:action,onPrepare(){}});
        const longDetail=Array.from({length:80},(_,index)=>`Failure ${index}: the source request could not be completed.`).join('\n');
        ui.update('error','翻译服务暂时不可用',{quiet,serviceSettings:true,errorDetails:longDetail});
        const details=ui.feedback.querySelector<HTMLDetailsElement>('details')!,row=ui.button.parentElement!;
        const recoveryBeforeDetails=()=>expect(Array.from(ui.feedback.children).indexOf(row))
            .toBeLessThan(Array.from(ui.feedback.children).indexOf(details));
        recoveryBeforeDetails();details.open=true;ui.refreshLanguage();
        expect(details.open).toBe(true);expect(details.querySelector('p')!.textContent).toBe(longDetail);
        expect(ui.button.parentElement).toBe(row);expect(ui.dismiss.parentElement).toBe(row);expect(row.parentElement).toBe(ui.feedback);
        recoveryBeforeDetails();
        ui.update('loading','正在翻译文字…',{quiet});expect(details.hidden).toBe(true);expect(details.open).toBe(false);
        expect(row.parentElement).toBe(ui.element);
        ui.update('error','仍未完成',{quiet,errorDetails:'new exact error'});recoveryBeforeDetails();
        expect(details.querySelector('p')!.textContent).toBe('new exact error');ui.dispose();
    });

    it('紧凑漫画错误保留完整可访问正文和悬浮全文，切换语言后同步且重新处理时撤下全文提示', () => {
        const {document}=parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
        let language:UiLanguage='zh-CN';
        const ui=createImageControls({onAction(){},onPrepare(){},translate:source=>translateLegacyText(source,language)});
        const message=imageLocalFailureMessage('failed');ui.update('error',message,{quiet:true,modelSettings:true,serviceSettings:true,errorDetails:'原始错误详情'});
        const text=ui.status.querySelector<HTMLSpanElement>('span:last-child')!;
        expect(text.textContent).toBe(message);expect(text.title).toBe(message);
        language='en-US';ui.refreshLanguage();expect(text.textContent).toBe(translateLegacyText(message,language));expect(text.title).toBe(text.textContent);
        expect(ui.feedback.querySelector('details')!.textContent).toContain('原始错误详情');
        ui.update('loading','正在识别图片文字…',{quiet:true});expect(text.title).toBe('');ui.dispose();
    });

    it('有限并发乱序完成后仍按原顺序返回，重复文字只请求一次',async()=>{
        const waits=new Map<string,ReturnType<typeof deferred<string>>>();
        const translateTexts=vi.fn((r:{origin:string|string[]})=>{const d=deferred<string>(); waits.set(r.origin as string,d);return d.promise;});
        const {handler}=setup({translateTexts});
        const pending=handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type:IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,texts:['a','b','a','c','d']});
        await vi.waitFor(()=>expect(waits.size).toBe(3));
        waits.get('c')!.resolve('丙');
        await vi.waitFor(()=>expect(waits.size).toBe(4));
        waits.get('d')!.resolve('丁'); waits.get('b')!.resolve('乙');waits.get('a')!.resolve('甲');
        await expect(pending).resolves.toEqual({success:true,translations:['甲','乙','甲','丙','丁']});
        expect(translateTexts).toHaveBeenCalledTimes(4);
    });
    it('图片批译只发送可翻译文字，符号、数字、网址和模型名按原行保留', async () => {
        const translateTexts = vi.fn(async (request: {origin: string[]}) => request.origin.map(text => `译:${text}`));
        const {handler} = setup({supportsBatchTranslation: () => true, translateTexts});
        const texts = ['—', '1', 'docs.sglang.io/cookbook', 'Decisions API', 'SGLang 0.5.21', 'Decisions API', 'Read docs.sglang.io/cookbook'];
        await expect(handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts}))
            .resolves.toEqual({success: true, translations: ['—', '1', 'docs.sglang.io/cookbook', '译:Decisions API', 'SGLang 0.5.21', '译:Decisions API', '译:Read docs.sglang.io/cookbook']});
        expect(translateTexts).toHaveBeenCalledOnce();
        expect(translateTexts.mock.calls[0][0].origin).toEqual(['Decisions API', 'Read docs.sglang.io/cookbook']);
    });
    it('只有不可翻译标识时无需请求供应商，重试也保留全部原文', async () => {
        const {handler, dependencies} = setup();
        const message = {type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['©', '22%', 'docs.sglang.io/cookbook'], requestId: 'identifiers'};
        for (let attempt = 0; attempt < 2; attempt++) {
            await expect(handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle(message))
                .resolves.toEqual({success: true, translations: message.texts});
        }
        expect(dependencies.translateTexts).not.toHaveBeenCalled();
    });
    it('逐条服务也跳过标识，保留单字、多语正文和重复行的对应位置', async () => {
        const {handler, dependencies} = setup();
        const texts = ['©', 'Read docs.sglang.io/cookbook', '1', 'a', '字', 'あ', 'Read docs.sglang.io/cookbook'];
        await expect(handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts}))
            .resolves.toEqual({success: true, translations: ['©', '译:Read docs.sglang.io/cookbook', '1', '译:a', '译:字', '译:あ', '译:Read docs.sglang.io/cookbook']});
        expect(dependencies.translateTexts).toHaveBeenCalledTimes(4);
    });
    it('明确的固定译名优先于技术标识跳过，其他标识仍保持原文', async () => {
        const {handler, dependencies} = setup({getGlossaryConfig: () => ({glossaryEnabled: true, from: 'en', to: 'zh-Hans',
            glossaryLibraries: [{id: 'identifiers', name: '技术标识', enabled: true, sourceLanguage: '', targetLanguage: '', domains: [],
                entries: [{id: 'url', source: 'docs.sglang.io/cookbook', target: '文档地址', caseSensitive: false}]}],
        })});
        const texts = ['docs.sglang.io/cookbook', '22%'];
        await expect(handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts}))
            .resolves.toEqual({success: true, translations: ['译:docs.sglang.io/cookbook', '22%']});
        expect(dependencies.translateTexts).toHaveBeenCalledOnce();
    });
    it('技术标识的固定译名仍受可信页面和源语言范围限制', async () => {
        const {handler, dependencies} = setup({getGlossaryConfig: () => ({glossaryEnabled: true, from: 'ja', to: 'zh-Hans',
            glossaryLibraries: [{id: 'site', name: '文档站', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: ['docs.example.com'],
                entries: [{id: 'url', source: 'docs.sglang.io/cookbook', target: '文档地址', caseSensitive: false}]}],
        })});
        const message = {type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['docs.sglang.io/cookbook'], sourceLanguage: 'en', glossaryRevision: 'revision'};
        await expect(handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle(message))
            .resolves.toEqual({success: true, translations: message.texts});
        expect(dependencies.translateTexts).not.toHaveBeenCalled();
        const trusted = attachTranslationGlossaryContext(message, {pageUrl: 'https://docs.example.com/article', context: 'page'});
        await expect(handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle(trusted))
            .resolves.toEqual({success: true, translations: ['译:docs.sglang.io/cookbook']});
        expect(dependencies.translateTexts).toHaveBeenCalledOnce();
    });
    it('图片读取服务配置时取消同一任务，批量和逐条模式都不得启动翻译', async () => {
        for (const batch of [true, false]) {
            let cancel!: () => void;
            const {handler, dependencies} = setup({supportsBatchTranslation: () => batch, getTranslationService: () => {cancel(); return 'google';}});
            cancel = () => {void handler(IMAGE_CANCEL_MESSAGE_TYPE).handle({type: IMAGE_CANCEL_MESSAGE_TYPE, requestId: 'config-cancel'});};
            await expect(handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['Hello'], requestId: 'config-cancel'}))
                .rejects.toMatchObject({name: 'AbortError'});
            expect(dependencies.translateTexts).not.toHaveBeenCalled();
        }
    });
    it('失败会取消同批在途请求且不启动余下段落；空白结果也视为失败',async()=>{
        const requests:any[]=[]; const first=deferred<string>();
        const {handler}=setup({translateTexts:vi.fn((r:any)=>{requests.push(r);return first.promise;})});
        const pending=handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type:IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,texts:['a','b','c','d']});
        await vi.waitFor(()=>expect(requests).toHaveLength(3));
        const failed=expect(pending).rejects.toThrow('空白译文'); first.resolve(' ');await failed;
        expect(requests).toHaveLength(3); expect(requests.every(r=>getTranslationRequestControl(r)?.signal?.aborted)).toBe(true);
        const batch=setup({supportsBatchTranslation:()=>true,translateTexts:vi.fn(async()=>[' '])});
        await expect(batch.handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type:IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,texts:['a']})).rejects.toThrow('非空字符串数组');
    });
    it('batch 去重仍恢复原行映射，并检查取消后返回',async()=>{
        const wait=deferred<string[]>(); const translateTexts=vi.fn(()=>wait.promise);
        const {handler}=setup({supportsBatchTranslation:()=>true,translateTexts});
        const pending=handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type:IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,texts:['a','a'],requestId:'batch'});
        await vi.waitFor(()=>expect(translateTexts).toHaveBeenCalledOnce());
        expect((translateTexts.mock.calls[0] as any)[0].origin).toEqual(['a']);
        const failed=expect(pending).rejects.toThrow('取消');
        await handler(IMAGE_CANCEL_MESSAGE_TYPE).handle({type:IMAGE_CANCEL_MESSAGE_TYPE,requestId:'batch'});
        wait.resolve(['甲']);await failed;
    });
    it('真实进度只允许 Offscreen 发送且只转交仍在处理的请求所属页',async()=>{
        const wait=deferred<any>(); const sendProgress=vi.fn(async()=>{});
        const {handler}=setup({translateImage:()=>wait.promise,sendProgress,isOffscreenSender:(c:any)=>c.sender?.url==='offscreen'});
        const owner={sender:{tab:{id:3},frameId:4}};
        const pending=handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle({type:IMAGE_TRANSLATE_MESSAGE_TYPE,image:'data:image/png,x',sourceLanguage:'en',requestId:'task'},owner);
        await new Promise(r=>setTimeout(r,0));
        const notify=handler(IMAGE_PROGRESS_MESSAGE_TYPE);
        const message={type:IMAGE_PROGRESS_MESSAGE_TYPE,requestId:'task',stage:'recognizing',progress:37} as const;
        await expect(notify.handle(message)).resolves.toEqual({success:false});
        await expect(notify.handle({...message,stage:'fake'},{sender:{url:'offscreen'}})).resolves.toEqual({success:false});
        await notify.handle(message,{sender:{url:'offscreen'}});
        expect(sendProgress).toHaveBeenCalledWith(owner,message);
        wait.resolve({image:'data:image/png,x',lines:[]});await pending;
        await notify.handle(message,{sender:{url:'offscreen'}});expect(sendProgress).toHaveBeenCalledOnce();
        const optional=setup(); await expect(optional.handler(IMAGE_PROGRESS_MESSAGE_TYPE).handle(message)).resolves.toEqual({success:false});
        expect(['preparing','recognizing','translating','cleaning','rendering'].every(isImageTranslationStage)).toBe(true);
        expect(isImageTranslationStage(null)).toBe(false);
    });
    it('客户端按请求过滤进度并在成功/取消后移除监听，准备使用当前源语言',async()=>{
        const wait=deferred<any>(); const listeners=new Set<(v:unknown)=>void>();
        const sendMessage=vi.fn(()=>wait.promise); const addListener=vi.fn((l:any)=>listeners.add(l)); const removeListener=vi.fn((l:any)=>listeners.delete(l));
        vi.stubGlobal('browser',{runtime:{sendMessage,onMessage:{addListener,removeListener}}});
        const onProgress=vi.fn();const pending=sendCancellableImageOperation({}, {requestId:'request',onProgress},'timeout');
        const callback=[...listeners][0];
        for (const v of [null,1,{}, {type:IMAGE_PROGRESS_MESSAGE_TYPE,requestId:'other',stage:'rendering'}, {type:IMAGE_PROGRESS_MESSAGE_TYPE,requestId:'request',stage:'bad'}]) callback(v);
        callback({type:IMAGE_PROGRESS_MESSAGE_TYPE,requestId:'request',stage:'rendering'});expect(onProgress).toHaveBeenCalledWith('rendering', undefined);
        callback({type:IMAGE_PROGRESS_MESSAGE_TYPE,requestId:'request',stage:'recognizing',progress:37});expect(onProgress).toHaveBeenLastCalledWith('recognizing',37);
        wait.resolve({success:true});await pending; expect(listeners.size).toBe(0); callback(null);
        await prepareImageOcrLanguages('ja');expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({languages:['jpn','eng']}));
        sendMessage.mockResolvedValueOnce({success:false,error:'network'});await expect(prepareImageOcrLanguages('en')).rejects.toThrow('network');
        sendMessage.mockResolvedValueOnce(undefined);await expect(prepareImageOcrLanguages('en')).rejects.toThrow('语言包准备失败');
    });
    it('准备语言包时只统计缺失的语言包，把依次下载合并成不倒退的百分比，结束或失败后取消订阅',async()=>{
        const wait=deferred<any>(); const storageListeners=new Set<(changes:Record<string,{newValue?:unknown}>,area:string)=>void>();
        const sendMessage=vi.fn((message:{type:string})=>message.type==='fluentReadImageOcrStatus'?Promise.resolve({success:true,languages:['chi_tra','unknown']}):wait.promise);
        vi.stubGlobal('browser',{runtime:{sendMessage,onMessage:{addListener:vi.fn(),removeListener:vi.fn()}},
            storage:{onChanged:{addListener:(l:any)=>storageListeners.add(l),removeListener:(l:any)=>storageListeners.delete(l)}}});
        const emit=(changes:Record<string,{newValue?:unknown}>)=>{for(const listener of storageListeners)listener(changes,'local');};
        const key=(language:string)=>`fluentReadDownloadProgress:ocr-language:${language}`;
        const onProgress=vi.fn();const pending=prepareImageOcrLanguages('auto',undefined,onProgress);
        await vi.waitFor(()=>expect(storageListeners.size).toBe(1));
        // 自动检测需要简繁英日四个包；繁体已下载，其余三个各占三分之一。
        emit({[key('chi_tra')]:{newValue:{loaded:1,total:2}}});expect(onProgress).not.toHaveBeenCalled();
        emit({[key('chi_sim')]:{newValue:{loaded:1,total:2}}});expect(onProgress).toHaveBeenLastCalledWith(16);
        emit({[key('chi_sim')]:{}});expect(onProgress).toHaveBeenLastCalledWith(33);
        emit({[key('eng')]:{newValue:{loaded:0,total:6}}});expect(onProgress).toHaveBeenLastCalledWith(33);
        emit({[key('eng')]:{newValue:{loaded:6,total:6}},[key('jpn')]:{newValue:{loaded:2,total:4}}});expect(onProgress).toHaveBeenLastCalledWith(83);
        expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({type:'fluentReadImageOcrDownload',languages:['chi_sim','chi_tra','eng','jpn']}));
        wait.resolve({success:true});await pending;expect(storageListeners.size).toBe(0);
        // 状态读取失败时按全部所需语言包统计，下载失败后同样取消订阅。
        const second=deferred<any>();
        sendMessage.mockRejectedValueOnce(new Error('status unavailable')).mockReturnValueOnce(second.promise);
        const failed=prepareImageOcrLanguages('en',undefined,onProgress);
        const rejection=expect(failed).rejects.toThrow('network');
        await vi.waitFor(()=>expect(storageListeners.size).toBe(1));
        emit({[key('eng')]:{newValue:{loaded:1,total:4}}});expect(onProgress).toHaveBeenLastCalledWith(25);
        second.resolve({success:false,error:'network'});await rejection;expect(storageListeners.size).toBe(0);
        // 状态读取同步抛错（例如扩展上下文失效）也不阻断下载请求。
        sendMessage.mockImplementationOnce(()=>{throw new Error('Extension context invalidated.');}).mockResolvedValueOnce({success:true});
        await expect(prepareImageOcrLanguages('en',undefined,onProgress)).resolves.toBeUndefined();expect(storageListeners.size).toBe(0);
    });
    it('操作条有可见阶段、取消、准备和完整文字，拒绝宿主页合成点击',()=>{
        const {document,window}=parseHTML('<html></html>');vi.stubGlobal('document',document);
        const onAction=vi.fn(),onPrepare=vi.fn(),onDismiss=vi.fn(),onInspect=vi.fn();const ui=createImageControls({onAction,onPrepare,onDismiss,onInspect});document.body.append(ui.feedback, ui.element);
        const click=(target:Element,trusted:boolean)=>{const e=new window.Event('click',{bubbles:true});Object.defineProperty(e,'isTrusted',{value:trusted});target.dispatchEvent(e);};
        ui.update('loading','正在识别文字');expect(ui.button.textContent).toBe('取消');expect(ui.status.hidden).toBe(false);
        expect(ui.element.className).toBe('fr-image-controls');
        expect(ui.feedback.hidden).toBe(false);
        expect(ui.spinner.getAttribute('aria-hidden')).toBe('true');
        ui.update('loading','正在识别文字',{animations:false});expect(ui.spinner.dataset.animated).toBe('true');
        click(ui.button,false);expect(onAction).not.toHaveBeenCalled();click(ui.button,true);expect(onAction).toHaveBeenCalledOnce();
        ui.update('error','首次使用需准备识别语言包，下载后自动继续',{prepare:true});const buttons=ui.feedback.querySelectorAll('button');expect(buttons).toHaveLength(6);expect(buttons[1].hidden).toBe(false);expect(buttons[1].textContent).toBe('下载语言包并翻译');expect(buttons[1].className).toBe('fr-image-prepare');expect(buttons[0].textContent).toBe('关闭');expect(ui.element.dataset.preparation).toBe('true');expect(ui.feedback.querySelector('.fr-image-actions')).not.toBeNull();click(buttons[1],true);expect(onPrepare).toHaveBeenCalledOnce();click(buttons[0],true);expect(onDismiss).toHaveBeenCalledOnce();
        expect(ui.feedback.hidden).toBe(false);
        ui.update('error','图片翻译失败：网络错误');expect(ui.dismiss.hidden).toBe(false);click(ui.dismiss,true);expect(onDismiss).toHaveBeenCalledTimes(2);
        ui.setLines([{text:'完整译文 <script>不执行</script>'}]);ui.update('translated','已翻译');expect(ui.status.hidden).toBe(true);click(buttons[2],true);expect(buttons[2].getAttribute('aria-expanded')).toBe('true');expect(ui.element.querySelector('script')).toBeNull();expect(onInspect).toHaveBeenCalledOnce();
        expect(ui.feedback.hidden).toBe(true);
        ui.element.dispatchEvent(new window.Event('wheel',{bubbles:true}));ui.update('idle','翻译图片');ui.setLines([]);ui.dispose();click(ui.button,true);expect(onAction).toHaveBeenCalledOnce();expect(ui.element.isConnected).toBe(false);
        const optional=createImageControls({onAction,onPrepare});optional.setLines([{text:'x'}]);optional.update('translated','完成');click(optional.element.querySelectorAll('button')[2],true);optional.dispose();
        const noDismiss = createImageControls({onAction, onPrepare});
        document.body.append(noDismiss.feedback, noDismiss.element);
        noDismiss.update('error', '首次使用需准备识别语言包，下载后自动继续', {prepare: true});
        expect(() => click(noDismiss.button, true)).not.toThrow();
        noDismiss.update('error', '图片翻译失败：网络错误');
        expect(() => click(noDismiss.dismiss, true)).not.toThrow();
        noDismiss.dispose();
    });

    it('连续识别进度只更新状态文字，保留取消按钮节点、父级和焦点', () => {
        const {document, window} = parseHTML('<html><body></body></html>');
        vi.stubGlobal('document', document);
        const ui = createImageControls({onAction() {}, onPrepare() {}});
        document.body.append(ui.feedback, ui.element);
        ui.update('loading', '正在识别图片文字…', {progress: 10});
        const row = ui.button.parentElement!;
        const append = vi.spyOn(ui.feedback, 'append');
        let focusEvents = 0;
        let blurEvents = 0;
        ui.button.addEventListener('focus', () => { focusEvents += 1; });
        ui.button.addEventListener('blur', () => { blurEvents += 1; });
        ui.button.dispatchEvent(new window.Event('focus'));
        const focusEventsBeforeProgress = focusEvents;
        const blurEventsBeforeProgress = blurEvents;

        ui.update('loading', '正在识别图片文字…', {progress: 40});
        ui.update('loading', '正在识别图片文字…', {progress: 70});

        expect(row.parentElement).toBe(ui.element);
        expect(ui.button.parentElement).toBe(row);
        expect(ui.feedback.contains(ui.button)).toBe(false);
        expect(focusEvents).toBe(focusEventsBeforeProgress);
        expect(blurEvents).toBe(blurEventsBeforeProgress);
        expect(append).not.toHaveBeenCalled();
        ui.dispose();
    });

    it('进度回调异常不影响后续进度或业务成功', async () => {
        const result = deferred<unknown>();
        const {listeners} = mockProgressClient(vi.fn(() => result.promise));
        const onProgress = vi.fn().mockImplementationOnce(() => {throw new Error('detached UI');});
        const pending = sendCancellableImageOperation({}, {requestId: 'callback', onProgress}, 'timeout');
        const notify = [...listeners][0];
        expect(() => notify({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'callback', stage: 'recognizing'})).not.toThrow();
        notify({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'callback', stage: 'translating'});
        result.resolve({success: true});
        await expect(pending).resolves.toEqual({success: true});
        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(listeners.size).toBe(0);
    });

    it('后台收到文字任务后立即取消，调度微任务不得再启动供应商请求', async () => {
        const translateTexts = vi.fn(async () => '不应调用');
        const {handler} = setup({translateTexts});
        const pending = handler(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['first', 'second'], requestId: 'before-dispatch',
        });
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await handler(IMAGE_CANCEL_MESSAGE_TYPE).handle({type: IMAGE_CANCEL_MESSAGE_TYPE, requestId: 'before-dispatch'});
        await rejected;
        await Promise.resolve();
        expect(translateTexts).not.toHaveBeenCalled();
    });

    it('同步消息发送异常立即清理进度、取消监听和超时计时器', async () => {
        vi.useFakeTimers();
        const {listeners} = mockProgressClient(vi.fn(() => {throw new Error('Extension context invalidated');}));
        const controller = new AbortController();
        const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
        await expect(sendCancellableImageOperation({}, {
            requestId: 'send-failed', signal: controller.signal, onProgress: vi.fn(),
        }, 'timeout')).rejects.toThrow('Extension context invalidated');
        expect(listeners.size).toBe(0);
        expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('上下文失效使取消通知同步失败时，本地取消仍立即结束', async () => {
        vi.useFakeTimers();
        let abortListener!: () => void;
        const signal = {
            aborted: false,
            addEventListener: (_type: string, listener: () => void) => {abortListener = listener;},
            removeEventListener: vi.fn(),
        } as unknown as AbortSignal;
        const sendMessage = vi.fn()
            .mockImplementationOnce(() => new Promise(() => undefined))
            .mockImplementationOnce(() => {throw new Error('Extension context invalidated');});
        const {listeners} = mockProgressClient(sendMessage);
        const pending = sendCancellableImageOperation({}, {requestId: 'abort', signal, onProgress: vi.fn()}, 'timeout');
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(() => abortListener()).not.toThrow();
        await rejected;
        expect(sendMessage).toHaveBeenLastCalledWith({type: 'fluentReadImageCancel', requestId: 'abort'});
        expect(listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('超时或后台异步失败都会清理进度，迟到的识别进度不再更新界面', async () => {
        vi.useFakeTimers();
        const result = deferred<unknown>();
        const sendMessage = vi.fn().mockReturnValueOnce(result.promise).mockRejectedValueOnce(new Error('cancel unavailable'));
        const {listeners} = mockProgressClient(sendMessage);
        const onProgress = vi.fn();
        const timedOut = sendCancellableImageOperation({}, {requestId: 'timeout', onProgress, timeoutMs: 20}, '图片翻译超时');
        const notify = [...listeners][0];
        const rejected = expect(timedOut).rejects.toMatchObject({name: 'TimeoutError', message: '图片翻译超时'});
        await vi.advanceTimersByTimeAsync(20);
        await rejected;
        notify({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'timeout', stage: 'rendering'});
        expect(onProgress).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
        result.resolve({success: true});
        await Promise.resolve();
        sendMessage.mockRejectedValueOnce(new Error('background failed'));
        await expect(sendCancellableImageOperation({}, {onProgress}, 'timeout')).rejects.toThrow('background failed');
        expect(listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('取消图片时立即删除进度路由，同标识重试不被旧请求迟到结束清除', async () => {
        const oldResult = deferred<unknown>();
        const newResult = deferred<unknown>();
        const translateImage = vi.fn().mockReturnValueOnce(oldResult.promise).mockReturnValueOnce(newResult.promise);
        const sendProgress = vi.fn(async () => undefined);
        const {handler} = setup({translateImage, sendProgress, isOffscreenSender: () => true});
        const message = {type: IMAGE_TRANSLATE_MESSAGE_TYPE, image: 'data:image/png,x', sourceLanguage: 'en', requestId: 'retry'} as const;
        const oldOwner = {sender: {tab: {id: 1}}};
        const newOwner = {sender: {tab: {id: 2}}};
        const oldRequest = handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle(message, oldOwner);
        await vi.waitFor(() => expect(translateImage).toHaveBeenCalledOnce());
        const oldRejected = expect(oldRequest).rejects.toMatchObject({name: 'AbortError'});
        await handler(IMAGE_CANCEL_MESSAGE_TYPE).handle({type: IMAGE_CANCEL_MESSAGE_TYPE, requestId: 'retry'});
        await oldRejected;
        const progress = {type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'retry', stage: 'rendering'} as const;
        await handler(IMAGE_PROGRESS_MESSAGE_TYPE).handle(progress);
        expect(sendProgress).not.toHaveBeenCalled();
        const retry = handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle(message, newOwner);
        await vi.waitFor(() => expect(translateImage).toHaveBeenCalledTimes(2));
        oldResult.resolve({image: 'old', lines: []});
        await new Promise(resolve => setTimeout(resolve, 0));
        await handler(IMAGE_PROGRESS_MESSAGE_TYPE).handle(progress);
        expect(sendProgress).toHaveBeenCalledWith(newOwner, progress);
        newResult.resolve({image: 'new', lines: []});
        await expect(retry).resolves.toEqual({success: true, image: 'new', lines: []});
        await handler(IMAGE_PROGRESS_MESSAGE_TYPE).handle(progress);
        expect(sendProgress).toHaveBeenCalledOnce();
    });

    it('翻译失败清理路由，缺省进度发送器不影响图片操作', async () => {
        const failedResult = deferred<unknown>();
        const translateImage = vi.fn(() => failedResult.promise);
        const sendProgress = vi.fn(async () => undefined);
        const {handler} = setup({translateImage, sendProgress, isOffscreenSender: () => true});
        const message = {type: IMAGE_TRANSLATE_MESSAGE_TYPE, image: 'data:image/png,x', sourceLanguage: 'en', requestId: 'failed'} as const;
        const pending = handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle(message);
        await vi.waitFor(() => expect(translateImage).toHaveBeenCalledOnce());
        const rejected = expect(pending).rejects.toThrow('render failed');
        failedResult.reject(new Error('render failed'));
        await rejected;
        await handler(IMAGE_PROGRESS_MESSAGE_TYPE).handle({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'failed', stage: 'rendering'});
        expect(sendProgress).not.toHaveBeenCalled();

        const waiting = deferred<unknown>();
        const optional = setup({translateImage: () => waiting.promise, isOffscreenSender: () => true});
        const operation = optional.handler(IMAGE_TRANSLATE_MESSAGE_TYPE).handle(message);
        await new Promise(resolve => setTimeout(resolve, 0));
        await expect(optional.handler(IMAGE_PROGRESS_MESSAGE_TYPE).handle({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'failed', stage: 'rendering'})).resolves.toEqual({success: true});
        waiting.resolve({image: 'result', lines: []});
        await operation;
    });

    it('操作条只隔离所属输入，详情重复开合并在原图和空译文时正确隐藏', () => {
        const {document, window} = parseHTML('<html><body></body></html>');
        vi.stubGlobal('document', document);
        const clicks: Array<(event: MouseEvent) => void> = [];
        const originalCreate = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
            const element = originalCreate(tag);
            const add = element.addEventListener.bind(element);
            element.addEventListener = ((event: string, listener: EventListener) => {
                if (event === 'click') clicks.push(listener as (event: MouseEvent) => void);
                add(event, listener);
            }) as typeof element.addEventListener;
            return element;
        });
        const onAction = vi.fn();
        const ui = createImageControls({onAction, onPrepare: vi.fn()});
        document.body.append(ui.feedback, ui.element);
        const inspect = ui.element.querySelectorAll<HTMLButtonElement>('.fr-image-actions button')[2];
        ui.update('translated', '完成');
        expect(inspect.hidden).toBe(true);
        ui.setLines([{text: '完整译文'}]);
        expect(inspect.hidden).toBe(false);
        const click = {isTrusted: true, stopPropagation: vi.fn(), target: inspect} as unknown as MouseEvent;
        const event = new window.Event('click', {bubbles: true});
        Object.defineProperty(event, 'isTrusted', {value: true});
        inspect.dispatchEvent(event);
        expect(inspect.getAttribute('aria-expanded')).toBe('true');
        inspect.dispatchEvent(event);
        expect(inspect.getAttribute('aria-expanded')).toBe('false');
        ui.setLines([]);
        expect(inspect.hidden).toBe(true);
        const hostInput = vi.fn();
        for (const type of ['pointerdown', 'keydown', 'keyup', 'wheel']) {
            document.body.addEventListener(type, hostInput);
            ui.element.dispatchEvent(new window.Event(type, {bubbles: true}));
            expect(hostInput).not.toHaveBeenCalled();
            document.body.dispatchEvent(new window.Event(type, {bubbles: true}));
            expect(hostInput).toHaveBeenCalledOnce();
            hostInput.mockClear();
        }
        ui.dispose();
        clicks[0]({...click, target: ui.button});
        expect(onAction).not.toHaveBeenCalled();
    });
});


describe('图片进度平台传输', () => {
    it('限定隔离文档来源并向原frame投递，页面关闭的失败安全结束', async () => {
        const sendMessage = vi.fn(async () => undefined);
        vi.stubGlobal('browser', {runtime: {getURL: () => 'chrome-extension://id/offscreen.html'}, tabs: {sendMessage}});
        expect(imageTranslationProgressTransport.isOffscreenSender({})).toBe(false);
        expect(imageTranslationProgressTransport.isOffscreenSender({sender: {url: 'https://example.com'}})).toBe(false);
        expect(imageTranslationProgressTransport.isOffscreenSender({sender: {url: 'chrome-extension://id/offscreen.html'}})).toBe(true);
        const message = {type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'id', stage: 'rendering'} as const;
        await imageTranslationProgressTransport.sendProgress({}, message);
        await imageTranslationProgressTransport.sendProgress({sender: {}}, message);
        expect(sendMessage).not.toHaveBeenCalled();
        await imageTranslationProgressTransport.sendProgress({sender: {tab: {id: 0}}}, message);
        expect(sendMessage).toHaveBeenLastCalledWith(0, message, {frameId: 0});
        sendMessage.mockRejectedValueOnce(new Error('tab closed'));
        await imageTranslationProgressTransport.sendProgress({sender: {tab: {id: 2}, frameId: 3}}, message);
        expect(sendMessage).toHaveBeenLastCalledWith(2, message, {frameId: 3});
    });
});


describe('图片控件界面语言', () => {
    it.each(['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const)('品牌通过现有旧文案端口按 %s 本地化', language => {
        const {document} = parseHTML('<html><body></body></html>');
        vi.stubGlobal('document', document);
        const ui = createImageControls({onAction() {}, onPrepare() {}, translate: source => translateLegacyText(source, language)});
        try {
            const brand = translate('common.brand', language);
            expect(translateLegacyText('流畅阅读', language)).toBe(brand);
            expect(ui.feedback.querySelector('.fr-image-feedback-title')!.textContent).toBe(`${brand} · ${translateLegacyText('图片翻译', language)}`);
            expect(ui.button.title).toBe(`${brand} · ${translateLegacyText('翻译图片', language)}`);
            expect(ui.button.getAttribute('aria-label')).toBe(ui.button.title);
            ui.update('loading', '正在识别图片文字…', {progress: 42});
            expect(ui.status.textContent).toContain('42%');
            expect(ui.button.title).toBe(`${brand} · ${translateLegacyText('取消图片翻译', language)}`);
        } finally {ui.dispose();}
    });
    it('语言刷新只修改控件与状态，保留展开状态和原始译文', () => {
        const {document} = parseHTML('<html><body></body></html>');
        vi.stubGlobal('document', document);
        let language: UiLanguage = 'en-US';
        const controls = createImageControls({onAction() {}, onPrepare() {}, translate: source => translateLegacyText(source, language)});
        controls.update('error', '没有识别到圈选区域文字', {prepare: true});
        expect(controls.status.textContent).toBe('No text was recognized in the selected region.');
        expect(controls.feedback.querySelectorAll('button')[1].textContent).toBe('Download language pack and translate');
        controls.setLines([{text: '原文'}]);
        controls.update('translated', '翻译完成');
        const details = controls.element.querySelector('pre')!;
        details.hidden = false;
        language = 'ja-JP'; controls.refreshLanguage();
        expect(controls.button.textContent).toBe('元画像');
        expect(controls.button.title).toBe('FluentRead · 元画像に戻す');
        expect(details.textContent).toBe('原文');
        expect(details.hidden).toBe(false);
        language = 'zh-CN'; controls.refreshLanguage();
        expect(controls.button.textContent).toBe('原图');
        expect(controls.button.title).toBe('流畅阅读 · 恢复原图');
        expect(details.textContent).toBe('原文');
        controls.dispose();
    });
});


describe('图片结果面板所有权', () => {
    it('打开另一图片可隐藏旧面板，关闭文字面板恢复入口的展开状态', () => {
        const {document,window}=parseHTML('<html></html>');vi.stubGlobal('document',document);
        const ui=createImageControls({onAction() {},onPrepare() {}});
        document.body.append(ui.element);
        const click=(node:Element)=>{const e=new window.Event('click',{bubbles:true});Object.defineProperty(e,'isTrusted',{value:true});node.dispatchEvent(e);};
        ui.setLines([{text:'译文',sourceText:'Source'}]);ui.update('translated','完成');
        const inspect=ui.element.querySelectorAll<HTMLButtonElement>('.fr-image-actions button')[2];
        click(inspect);expect(ui.reader.hidden).toBe(false);
        ui.hideReader();expect(ui.reader.hidden).toBe(true);expect(inspect.getAttribute('aria-expanded')).toBe('false');
        click(inspect);click(ui.reader.querySelectorAll('header button')[1]);
        expect(ui.reader.hidden).toBe(true);expect(inspect.getAttribute('aria-expanded')).toBe('false');
        ui.dispose();
    });
});


it('漫画未绘制提示在安静完成状态仍可见并在恢复后撤下',()=>{
    const {document}=parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
    const ui=createImageControls({onAction:()=>{},onPrepare:()=>{}});
    ui.update('translated','部分译文未绘制，请查看漫画文字',{quiet:true,warning:true,warningAction:true});
    expect(ui.feedback.hidden).toBe(false);expect(ui.status.hidden).toBe(true);
    const warning=ui.feedback.querySelector('.fr-image-warning-button')!;
    expect(warning.textContent).toBe('未绘制');expect(warning.getAttribute('aria-label')).toBe('部分译文未绘制，请查看漫画文字');
    ui.update('idle','翻译图片',{quiet:true});expect(ui.feedback.hidden).toBe(true);ui.dispose();
});


it('纯识别状态以短文案显示并保留完整无障碍说明',()=>{
    const {document}=parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
    const ui=createImageControls({onAction:()=>{},onPrepare:()=>{}});
    ui.update('translated','已识别文字，原图未改动',{quiet:true,warning:true});
    expect(ui.feedback.hidden).toBe(false);expect(ui.status.textContent).toBe('已识别');
    expect(ui.status.getAttribute('aria-label')).toBe('已识别文字，原图未改动');ui.dispose();
});


it('警示按钮只对可信点击调用阅读入口',()=>{
    const {document,window}=parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
    const onWarning=vi.fn(),ui=createImageControls({onAction:()=>{},onPrepare:()=>{},onWarning});
    ui.update('translated','部分译文未绘制，请查看漫画文字',{quiet:true,warning:true,warningAction:true});
    const warning=ui.feedback.querySelector('.fr-image-warning-button')!;
    for(const trusted of [false,true]){const event=new window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:trusted});warning.dispatchEvent(event);}
    expect(onWarning).toHaveBeenCalledOnce();ui.dispose();
});

it('普通图片未绘制译文时显示可操作提示，并在文字面板标明对应段落',()=>{
    const {document,window}=parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
    const ui=createImageControls({onAction(){},onPrepare(){}});document.body.append(ui.element,ui.feedback);
    ui.setLines([{text:'你好',sourceText:'Hello',renderSkipped:true},{text:'KEEP',sourceText:'KEEP'}]);
    ui.update('translated','部分译文未绘制，请查看图片文字',{warning:true,warningAction:true});
    const warning=ui.feedback.querySelector<HTMLButtonElement>('.fr-image-warning-button')!;
    expect(ui.feedback.hidden).toBe(false);expect(warning?.hidden).toBe(false);
    const click=(trusted:boolean)=>{const event=new window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:trusted});warning.dispatchEvent(event);};
    click(false);expect(ui.reader.hidden).toBe(true);click(true);expect(ui.reader.hidden).toBe(false);
    expect(ui.reader.textContent).toContain('为保留原文，此译文未绘制到图片');expect(ui.reader.textContent).toContain('你好');
    const host=vi.fn();for(const type of ['touchstart','touchmove','touchend','touchcancel'])document.body.addEventListener(type,host);
    for(const type of ['touchstart','touchmove','touchend','touchcancel']){const event=new window.Event(type,{bubbles:true,cancelable:true});ui.reader.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);}
    expect(host).not.toHaveBeenCalled();
    ui.dispose();
});

it('普通窄图提示使用短图标和完整本地化名称，键盘与触摸输入不冒泡',()=>{
    const {document,window}=parseHTML('<html><body></body></html>');vi.stubGlobal('document',document);
    const ui=createImageControls({onAction(){},onPrepare(){},translate:source=>translateLegacyText(source,'fr-FR')});document.body.append(ui.element,ui.feedback);
    ui.feedback.style.maxWidth='64px';ui.setLines([{text:'Bonjour',sourceText:'Hello',renderSkipped:true}]);
    ui.update('translated','部分译文未绘制，请查看图片文字',{warning:true,warningAction:true});
    const warning=ui.feedback.querySelector<HTMLButtonElement>('.fr-image-warning-button')!;
    expect(warning.textContent).toBe('!');expect(warning.getAttribute('aria-label')).toContain(translateLegacyText('部分译文未绘制，请查看图片文字','fr-FR'));expect(warning.getAttribute('aria-label')).toContain(translateLegacyText('查看图片文字','fr-FR'));
    const host=vi.fn();for(const type of ['keydown','touchstart','touchend'])document.body.addEventListener(type,host);
    for(const type of ['keydown','touchstart','touchend']){const event=new window.Event(type,{bubbles:true,cancelable:true});warning.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);}
    expect(host).not.toHaveBeenCalled();const click=new window.Event('click',{bubbles:true});Object.defineProperty(click,'isTrusted',{value:true});warning.dispatchEvent(click);
    expect(ui.reader.hidden).toBe(false);expect(ui.reader.textContent).toContain(translateLegacyText('为保留原文，此译文未绘制到图片','fr-FR'));ui.dispose();
});

it('普通图片文字提示在明暗面板背景上保持可读对比度',()=>{
    const light=IMAGE_READER_CSS.match(/--fr-image-muted:#([\da-f]{6})/)?.[1],dark=IMAGE_READER_CSS.match(/\[data-theme=dark\][^{]*\{[^}]*--fr-image-muted:#([\da-f]{6})/)?.[1];
    const luminance=(hex:string)=>{const rgb=hex.match(/[\da-f]{2}/gi)!.map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
    const contrast=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    expect(light).toBeDefined();expect(dark).toBeDefined();expect(contrast(light!,'ffffff')).toBeGreaterThanOrEqual(4.5);expect(contrast(dark!,'2b2630')).toBeGreaterThanOrEqual(4.5);
});

it.each(['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES'] as const)('普通图片保留原文提示使用 %s 界面文案',language=>{
    for(const message of ['部分译文未绘制，请查看图片文字','为保留原文，此译文未绘制到图片','查看图片文字']) expect(translateLegacyText(message,language)).not.toBe(message);
});
