import {afterEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {createVisionProbeHandlers} from '@/src/app/background/handlers/visionProbe';
import {VISION_PROBE_MESSAGE, VISION_PROBE_CANCEL_MESSAGE} from '@/src/services/translation/types';
import {createVisionProbeIdentity} from '@/src/core/config/visionProbe';
import {prepareModelVisionRoute, freezeVisionProbeConfig} from '@/src/services/translation/visionProbe';
import {createAreaTranslationBackgroundHandlers, AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, type AreaTranslationBackgroundDependencies} from '@/src/features/area-translation/background';

type AreaVisionResolver = ReturnType<NonNullable<AreaTranslationBackgroundDependencies<object>['prepareVisionRoute']>>;

const context = {sender:{url:'chrome-extension://fixture/options.html'}};
const config = () => { const c=new Config();c.service='deepseek';c.model.deepseek='future-vision'; return c; };
afterEach(() => vi.useRealTimers());
describe('识图测试后台契约与圈选路由',()=>{
    it('等待后台配置就绪也属于可取消操作，取消立即结束消息且迟到就绪不启动探测', async () => {
        let ready!: () => void;const waiting = new Promise<void>(resolve => {ready = resolve;});const source = config();
        const resolve = vi.fn(async () => ({capability: 'supported' as const, source: 'probe' as const}));const getConfig = vi.fn(() => source);
        const [test, cancel] = createVisionProbeHandlers({ready: waiting, getConfig, isSettingsUrl: () => true, resolve});
        const job = test.handle({type: VISION_PROBE_MESSAGE, service: 'deepseek', model: 'future-vision', requestId: 'ready-cancel',
            identity: createVisionProbeIdentity(source, 'deepseek', 'future-vision')}, context);
        let ended = false;void Promise.resolve(job).catch(() => {ended = true;});await Promise.resolve();
        const cancellation = cancel.handle({type: VISION_PROBE_CANCEL_MESSAGE, requestId: 'ready-cancel'}, context);
        for (let i = 0; i < 12; i++) await Promise.resolve();
        try {expect(cancellation).toMatchObject({cancelled: true});expect(ended).toBe(true);}
        finally {ready();await Promise.allSettled([job]);}
        expect(getConfig).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
    });
    it('挂起的后台配置在30秒总预算结束，迟到就绪不计算配置或请求', async () => {
        vi.useFakeTimers();let ready!: () => void;const waiting = new Promise<void>(resolve => {ready = resolve;});const source = config();
        const resolve = vi.fn(async () => ({capability: 'supported' as const, source: 'probe' as const}));const getConfig = vi.fn(() => source);
        const [test] = createVisionProbeHandlers({ready: waiting, getConfig, isSettingsUrl: () => true, resolve});
        const job = test.handle({type: VISION_PROBE_MESSAGE, service: 'deepseek', model: 'future-vision', requestId: 'ready-timeout',
            identity: createVisionProbeIdentity(source, 'deepseek', 'future-vision')}, context);
        let error: any;void Promise.resolve(job).catch(value => {error = value;});await vi.advanceTimersByTimeAsync(30000);
        try {expect(error?.name).toBe('TimeoutError');expect(vi.getTimerCount()).toBe(0);}
        finally {ready();await Promise.allSettled([job]);}
        expect(getConfig).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
    });
    it('消息字段在首次等待前冻结，调用者后续修改不替换受测服务和模型', async () => {
        let ready!: () => void;const waiting = new Promise<void>(resolve => {ready = resolve;});const source = config();
        const resolve = vi.fn(async () => ({capability: 'supported' as const, source: 'probe' as const}));
        const [test] = createVisionProbeHandlers({ready: waiting, getConfig: () => source, isSettingsUrl: () => true, resolve});
        const message = {type: VISION_PROBE_MESSAGE, service: 'deepseek', model: 'future-vision', requestId: 'snapshot', identity: createVisionProbeIdentity(source, 'deepseek', 'future-vision')};
        const job = test.handle(message, context);message.service = 'openai';message.model = 'another';message.identity = 'stale';message.requestId = 'replaced';ready();
        await expect(job).resolves.toMatchObject({success: true});expect(resolve.mock.calls[0]).toMatchObject([{}, 'deepseek', 'future-vision', {force: true}]);
    });
    it('等待就绪期间同一编号只能归属一个操作，结束后该编号可以重新使用', async () => {
        let ready!: () => void;const waiting = new Promise<void>(resolve => {ready = resolve;});const source = config();
        const resolve = vi.fn(async () => ({capability: 'supported' as const, source: 'probe' as const}));
        const [test] = createVisionProbeHandlers({ready: waiting, getConfig: () => source, isSettingsUrl: () => true, resolve});
        const message = {type: VISION_PROBE_MESSAGE, service: 'deepseek', model: 'future-vision', requestId: 'ready-duplicate', identity: createVisionProbeIdentity(source, 'deepseek', 'future-vision')};
        const first = test.handle(message, context), second = test.handle(message, context);let rejected = false;void Promise.resolve(second).catch(() => {rejected = true;});
        for (let i = 0; i < 12; i++) await Promise.resolve();try {expect(rejected).toBe(true);} finally {ready();await Promise.allSettled([first, second]);}
        await expect(test.handle(message, context)).resolves.toMatchObject({success: true});expect(resolve).toHaveBeenCalledTimes(2);
    });
    it('圈选使用异步能力判断，支持时跳过 OCR，未知时标明回退，检测错误不触发 OCR',async()=>{
        const resolve=vi.fn<AreaVisionResolver>().mockResolvedValueOnce({mode:'vision'}).mockResolvedValueOnce({mode:'ocr',fallback:'unknown'}).mockRejectedValueOnce(new Error('HTTP 401'));
        const ocr=vi.fn(async()=>({image:'cropped',lines:[]})), vision=vi.fn(async()=>({image:'cropped',lines:[],recognitionMethod:'vision'}));
        const languages=vi.fn(async()=>undefined);
        const [,handler]=createAreaTranslationBackgroundHandlers({captureVisibleTab:async()=>'',getDefaultSourceLanguage:()=> 'en',assertLanguagesDownloaded:languages,
            prepareVisionRoute:()=>resolve,prepareVisionTranslation:()=>vision,translateArea:ocr});
        const message={type:AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,image:'data:image/png,x',selection:{left:0,top:0,width:20,height:20,viewportWidth:100,viewportHeight:100}};
        await expect(handler.handle(message,{})).resolves.toMatchObject({recognitionMethod:'vision'});expect(ocr).not.toHaveBeenCalled();expect(languages).not.toHaveBeenCalled();
        await expect(handler.handle(message,{})).resolves.toMatchObject({recognitionMethod:'ocr',recognitionFallback:'unknown'});
        await expect(handler.handle(message,{})).rejects.toThrow('401');expect(ocr).toHaveBeenCalledOnce();
    });
    it('只接受真实设置页和当前配置身份，拒绝非法服务、模型和旧配置',async()=>{
        const source=config(), resolve=vi.fn(async(_source:unknown,_service:string,_model:string,_options:unknown)=>({capability:'supported' as const,source:'probe' as const}));
        const [test,cancel]=createVisionProbeHandlers({ready:Promise.resolve(),getConfig:()=>source,isSettingsUrl:url=>url===context.sender.url,resolve});
        const message={type:VISION_PROBE_MESSAGE,service:'deepseek',model:'future-vision',requestId:'probe-1',identity:createVisionProbeIdentity(source,'deepseek','future-vision')};
        await expect(test.handle(message,{})).rejects.toThrow('设置页');
        expect(()=>cancel.handle({type:VISION_PROBE_CANCEL_MESSAGE},{})).toThrow('设置页');
        for(const patch of [{service:null},{service:' '},{model:null},{model:' '},{identity:'stale'}]) await expect(test.handle({...message,...patch},context)).rejects.toThrow();
        const pending=test.handle(message,context); source.token.deepseek='changed';
        await expect(pending).rejects.toThrow('已更改');
        const result=test.handle({...message,identity:createVisionProbeIdentity(source,'deepseek','future-vision')},context);
        await expect(result).resolves.toMatchObject({success:true,capability:'supported'});
        expect(resolve.mock.calls[0]?.[0]).not.toBe(source);
    });
    it('取消测试会中止真实请求，提前取消不启动请求，错误直接传给路由器',async()=>{
        const source=config();let signal:AbortSignal | undefined;
        const resolve=vi.fn(async(_c,_s,_m,options)=> {signal=options.signal;return new Promise<any>((_r,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted'))));});
        const [test,cancel]=createVisionProbeHandlers({ready:Promise.resolve(),getConfig:()=>source,isSettingsUrl:()=>true,resolve});
        const message={type:VISION_PROBE_MESSAGE,service:'deepseek',model:'future-vision',requestId:'probe-1',identity:createVisionProbeIdentity(source,'deepseek','future-vision')};
        const result=test.handle(message,context);const failure=expect(result).rejects.toMatchObject({name:'AbortError'});
        await vi.waitFor(()=>expect(resolve).toHaveBeenCalledOnce());
        expect(cancel.handle({type:VISION_PROBE_CANCEL_MESSAGE,requestId:'probe-1'},context)).toMatchObject({cancelled:true});
        await failure;expect(signal?.aborted).toBe(true);
        cancel.handle({type:VISION_PROBE_CANCEL_MESSAGE,requestId:'probe-2'},context);
        await expect(test.handle({...message,requestId:'probe-2'},context)).rejects.toMatchObject({name:'AbortError'});
        resolve.mockRejectedValueOnce(new Error('HTTP 401'));
        await expect(test.handle({...message,requestId:'probe-3'},context)).rejects.toThrow('401');
    });
    it('首次圈选在等待前冻结模型、密钥、覆盖与模式，再由能力结论选择识别路径',async()=>{
        const source=config(); source.areaRecognitionMode='prefer-vision';source.modelVision.deepseek={'future-vision':true};
        const resolve=vi.fn(async()=>({capability:'supported' as const,source:'probe' as const}));
        const run=prepareModelVisionRoute(source,resolve);
        source.service='freeTranslation';source.model.deepseek='other';source.modelVision.deepseek['future-vision']=false;source.areaRecognitionMode='ocr';
        await expect(run({})).resolves.toEqual({mode:'vision'});
        expect(resolve.mock.calls[0]).toMatchObject([{model:{deepseek:'future-vision'},modelVision:{deepseek:{'future-vision':true}}},'deepseek','future-vision',{probeUnknown:true}]);
        expect(freezeVisionProbeConfig({...config(),modelVision:undefined}).modelVision).toEqual({});
    });
    it('本地 OCR 不探测，明确不支持或无法确认走 OCR，探测网络失败不回退',async()=>{
        const source=config(), resolve=vi.fn<Parameters<typeof prepareModelVisionRoute>[1]>().mockResolvedValueOnce({capability:'unsupported',source:'probe'}).mockResolvedValueOnce({capability:'unknown',source:'unknown'}).mockRejectedValueOnce(new Error('network'));
        source.areaRecognitionMode='ocr';await expect(prepareModelVisionRoute(source,resolve)({})).resolves.toMatchObject({mode:'ocr'});expect(resolve).not.toHaveBeenCalled();
        source.areaRecognitionMode='prefer-vision';const run=prepareModelVisionRoute(source,resolve);
        await expect(run({})).resolves.toEqual({mode:'ocr',fallback:'unsupported'});
        await expect(run({})).resolves.toEqual({mode:'ocr',fallback:'unknown'});
        await expect(run({})).rejects.toThrow('network');
    });
});
