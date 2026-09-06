import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {createImageTranslationBackgroundHandlers, IMAGE_TRANSLATE_MESSAGE_TYPE, IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, IMAGE_CANCEL_MESSAGE_TYPE} from '@/src/features/image-translation/background/handlers';
import {IMAGE_PROGRESS_MESSAGE_TYPE, isImageTranslationStage, normalizeImageProgress} from '@/src/features/image-translation/progress';
import {createImageControls} from '@/src/features/image-translation/content/controls';
import {sendCancellableImageOperation, prepareImageOcrLanguages} from '@/src/features/image-translation/services/client';
import {imageTranslationProgressTransport} from '@/src/features/image-translation/background/offscreenAdapter';
import {getTranslationRequestControl} from '@/src/services/translation/requestSnapshot';

const deferred = <T>() => {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r,j) => {resolve=r;reject=j;}); return {promise,resolve,reject};};
function setup(extra = {}) {
    const dependencies = {assertLanguagesDownloaded: vi.fn(async()=>{}), recognizeImage:vi.fn(async()=>[]), translateImage:vi.fn(async()=>({image:'data:image/png,x',lines:[]})),fetchImage:vi.fn(async()=>''),getTranslationService:()=> 'google',supportsBatchTranslation:()=>false,translateTexts:vi.fn(async(request:{origin:string|string[]})=>`译:${request.origin}`),downloadLanguages:vi.fn(async()=>{}),markLanguagesDownloaded:vi.fn(async()=>[]), ...extra};
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

describe('图片翻译流程优化',()=>{
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
        expect(['recognizing','translating','rendering'].every(isImageTranslationStage)).toBe(true);
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
    it('操作条有可见阶段、取消、准备和完整文字，拒绝宿主页合成点击',()=>{
        const {document,window}=parseHTML('<html></html>');vi.stubGlobal('document',document);
        const onAction=vi.fn(),onPrepare=vi.fn(),onDismiss=vi.fn(),onInspect=vi.fn();const ui=createImageControls({onAction,onPrepare,onDismiss,onInspect});document.body.append(ui.feedback, ui.element);
        const click=(target:Element,trusted:boolean)=>{const e=new window.Event('click',{bubbles:true});Object.defineProperty(e,'isTrusted',{value:trusted});target.dispatchEvent(e);};
        ui.update('loading','正在识别文字');expect(ui.button.textContent).toBe('取消');expect(ui.status.hidden).toBe(false);
        expect(ui.element.className).toBe('fr-image-controls');
        expect(ui.feedback.hidden).toBe(false);
        expect(ui.spinner.getAttribute('aria-hidden')).toBe('true');
        ui.update('loading','正在识别文字',{animations:false});expect(ui.spinner.dataset.animated).toBe('false');
        click(ui.button,false);expect(onAction).not.toHaveBeenCalled();click(ui.button,true);expect(onAction).toHaveBeenCalledOnce();
        ui.update('error','首次使用需准备识别语言包，下载后自动继续',{prepare:true});const buttons=ui.feedback.querySelectorAll('button');expect(buttons).toHaveLength(4);expect(buttons[1].hidden).toBe(false);expect(buttons[1].textContent).toBe('下载语言包并翻译');expect(buttons[1].className).toBe('fr-image-prepare');expect(buttons[0].textContent).toBe('关闭');expect(ui.element.dataset.preparation).toBe('true');expect(ui.feedback.querySelector('.fr-image-actions')).not.toBeNull();click(buttons[1],true);expect(onPrepare).toHaveBeenCalledOnce();click(buttons[0],true);expect(onDismiss).toHaveBeenCalledOnce();
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
        const inspect = ui.element.querySelectorAll('button')[2];
        ui.update('translated', '完成');
        expect(inspect.hidden).toBe(true);
        ui.setLines([{text: '完整译文'}]);
        expect(inspect.hidden).toBe(false);
        const click = {isTrusted: true, stopPropagation: vi.fn(), target: inspect} as unknown as MouseEvent;
        clicks[0](click);
        expect(inspect.getAttribute('aria-expanded')).toBe('true');
        clicks[0](click);
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
        expect(details.textContent).toBe('原文');
        controls.dispose();
    });
});
