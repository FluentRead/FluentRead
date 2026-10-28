import {afterEach, describe, expect, it, vi} from 'vitest';
import {inflateSync} from 'node:zlib';
import {Config} from '@/src/core/config/model';
import {createVisionProbeImage} from '@/src/core/translation/visionProbeImage';
import {createVisionProbeIdentity, resolveVisionCapabilityWithProbe, isExplicitImageInputRejection, matchesVisionProbeAnswer, normalizeVisionProbeRecords,
    VISION_PROBE_TTL_MS} from '@/src/core/config/visionProbe';
import {createModelVisionProbe} from '@/src/services/translation/visionProbe';
import {getTranslationImageInput, getTranslationProviderConfig, getTranslationRequestControl} from '@/src/services/translation/requestSnapshot';
import {createImageInputHttpError} from '@/src/platform/http/errors';

const base = () => { const config = new Config(); config.model.deepseek = 'future-vision'; config.token.deepseek = 'test-key'; return config; };
const store = () => ({load: vi.fn(async (): Promise<unknown> => []), save: vi.fn(async (_records: unknown): Promise<void> => undefined)});
const random = () => Uint8Array.from([0xab, 0xcd, 0xef]);
const pending = () => { let resolve!: (v: string) => void; const promise = new Promise<string>(r => {resolve = r;}); return {promise, resolve}; };

describe('识图挑战图和能力规则', () => {
    it('服务设置和圈选设置共同遵守手动、有效缓存、规则与未知的优先级',()=>{
        const source=base(); const identity=createVisionProbeIdentity(source,'deepseek','future-vision');
        const record={identity,capability:'supported',checkedAt:10};
        expect(resolveVisionCapabilityWithProbe(source,'freeTranslation','',[record],20)).toEqual({capability:'unsupported',source:'rule'});
        expect(resolveVisionCapabilityWithProbe(source,'deepseek','future-vision',[record],20)).toEqual({capability:'supported',source:'probe',checkedAt:10});
        source.modelVision.deepseek={'future-vision':false};
        expect(resolveVisionCapabilityWithProbe(source,'deepseek','future-vision',[record],20)).toEqual({capability:'unsupported',source:'override'});
        source.modelVision={};
        expect(resolveVisionCapabilityWithProbe(source,'deepseek','future-vision',[record],VISION_PROBE_TTL_MS+10)).toEqual({capability:'unknown',source:'unknown'});
        expect(resolveVisionCapabilityWithProbe(source,'deepseek','deepseek-flash',[],20)).toEqual({capability:'supported',source:'rule'});
        expect(resolveVisionCapabilityWithProbe({...source,modelVision:undefined},'deepseek','future-vision',[],20)).toEqual({capability:'unknown',source:'unknown'});
    });
    it('产生有效微型 PNG，只把答案写进像素，覆盖每种字符', () => {
        expect(() => createVisionProbeImage(new Uint8Array())).toThrow('三个随机字节');
        for (const bytes of [random(), Uint8Array.from([0x01, 0x23, 0x45]), Uint8Array.from([0x67, 0x89, 0xab])]) {
            const {answer, image} = createVisionProbeImage(bytes);
            const png = Buffer.from(image.split(',')[1], 'base64');
            expect(png.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
            expect(png.readUInt32BE(16)).toBe(224); expect(png.readUInt32BE(20)).toBe(64);
            expect(png.includes(Buffer.from(answer))).toBe(false);
            const data = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
            expect(data.length).toBe(29 * 64);
            expect(data.subarray(1,29)).toEqual(Buffer.alloc(28,255));
            expect(data.some((v, i) => i % 29 !== 0 && v !== 255)).toBe(true);
        }
    });
    it('绑定端点、模型、协议、密钥及自定义请求头，摘要不含凭据', () => {
        const source = base(); const identity = createVisionProbeIdentity(source, 'deepseek', 'future-vision');
        expect(identity).toMatch(/^[a-f0-9]{64}$/u);
        for (const change of [(s: Config) => {s.proxy.deepseek = 'https://different.test';}, (s: Config) => {s.token.deepseek = 'different';},
            (s: Config) => {s.deepseekApiType = 'responses';}, (s: Config) => {s.customHeaders.deepseek = '{"X-Test":"private"}';}]) {
            const changed = base(); change(changed);
            expect(createVisionProbeIdentity(changed, 'deepseek', 'future-vision')).not.toBe(identity);
        }
        expect(createVisionProbeIdentity(source, 'deepseek', 'other')).not.toBe(identity);
    });
    it('清除无效、过期、未来时间、过量缓存，并丢弃额外字段', () => {
        expect(normalizeVisionProbeRecords(null, 10)).toEqual([]);
        const good = {identity: 'a'.repeat(64), capability: 'supported', checkedAt: 10, secret: 'discard'};
        expect(normalizeVisionProbeRecords([null, false, {}, {...good, identity: 'bad'}, {...good, capability:'unknown'},
            {...good, checkedAt: 11}, {...good, checkedAt: -VISION_PROBE_TTL_MS}, good], 10)).toEqual([{identity:good.identity, capability:'supported',checkedAt:10}]);
        expect(normalizeVisionProbeRecords(Array.from({length:101},(_,i)=>({...good,checkedAt:i})),101)).toHaveLength(100);
    });
    it('严格检查完整答案，并区分图片模态拒绝和其他失败', () => {
        expect(matchesVisionProbeAnswer(' abcdef\n','ABCDEF')).toBe(true);
        for (const value of [null,['ABCDEF'],'The code is ABCDEF','UNKNOWN','ABCDE0']) expect(matchesVisionProbeAnswer(value,'ABCDEF')).toBe(false);
        expect(isExplicitImageInputRejection(400,'This model does not support image input')).toBe(true);
        expect(isExplicitImageInputRejection(422,'image_url is not supported for this model')).toBe(true);
        expect(isExplicitImageInputRejection(400,'此模型不支持图片输入')).toBe(true);
        for (const [status,detail] of [[401,'image input unsupported'],[429,'image input unsupported'],[500,'image input unsupported'],
            [400,'unsupported image format'],[400,'invalid image size'],[400,'invalid model'],[400,'image corrupted']]) expect(isExplicitImageInputRejection(status as number,detail as string)).toBe(false);
    });
    it('仅将明确 JSON 图片拒绝转为安全标记，不泄露响应正文', async () => {
        const make = (status:number, body: unknown) => new Response(JSON.stringify(body),{status});
        await expect(createImageInputHttpError(make(400,{error:{message:'This model does not support image input; test-secret'}}))).resolves.toMatchObject({statusCode:400,imageInputUnsupported:true,message:'请求失败: 400'});
        await expect(createImageInputHttpError(make(422,{message:'image input not supported'}),'测试失败')).resolves.toMatchObject({imageInputUnsupported:true});
        for (const response of [make(401,{message:'image input unsupported'}),make(400,{}),make(400,{message:7}),
            make(400,{message:'image input unsupported'+'x'.repeat(2048)}),make(400,{message:'unsupported image format'}),new Response('not-json',{status:400})]) {
            expect((await createImageInputHttpError(response) as any).imageInputUnsupported).toBeUndefined();
        }
    });
});

describe('共享识图探测服务', () => {
    afterEach(() => vi.useRealTimers());
    it('规则和手动设置优先，不主动发送已知模型或机器翻译请求', async () => {
        const storage = store(), translate = vi.fn(async () => 'ABCDEF'); const service = createModelVisionProbe({storage,translate}); const source=base();
        await expect(service.resolve(source,'freeTranslation','')).resolves.toEqual({capability:'unsupported',source:'rule'});
        source.modelVision.deepseek={'future-vision':false};
        await expect(service.resolve(source,'deepseek','future-vision')).resolves.toEqual({capability:'unsupported',source:'override'});
        await expect(service.resolve(source,'deepseek','deepseek-flash')).resolves.toEqual({capability:'supported',source:'rule'});
        await expect(service.resolve(source,'deepseek','deepseek-v4-pro')).resolves.toEqual({capability:'unsupported',source:'rule'});
        await expect(service.resolve(base(),'deepseek','future-vision')).resolves.toEqual({capability:'unknown',source:'unknown'});
        expect(translate).not.toHaveBeenCalled();
    });
    it('图片测试冻结配置，复用真实模型和信号，禁止 prompt、body、术语、上下文和缓存干扰', async () => {
        const source=base(); let now=100; const storage=store(); const wait=pending();
        const translate=vi.fn(async(request:any)=>{
            expect(request.serviceOverride).toBe('deepseek'); expect(request.modelOverride).toBe('future-vision');
            expect(request.useCache).toBe(false); expect(request.thinkingOverride).toBe(false); expect(request.glossaryIds).toEqual([]);
            expect(request.origin).not.toContain('ABCDEF'); expect(JSON.stringify(request)).not.toContain('base64');
            expect(getTranslationImageInput(request)).toBe(createVisionProbeImage(random()).image);
            const snapshot=getTranslationProviderConfig(request,source);
            expect(snapshot.token.deepseek).toBe('test-key'); expect(snapshot.translationMaxRetries).toBe(0);
            expect(snapshot.user_role.deepseek).toContain('six hexadecimal');
            expect(getTranslationRequestControl(request)?.signal).toBeInstanceOf(AbortSignal);
            return wait.promise;
        });
        const service=createModelVisionProbe({storage,translate,random,now:()=>now});
        const result=service.resolve(source,'deepseek','future-vision',{probeUnknown:true});
        source.token.deepseek='changed'; source.user_role.deepseek='changed';
        await vi.waitFor(()=>expect(translate).toHaveBeenCalledOnce()); now=200; wait.resolve('abcdef');
        await expect(result).resolves.toEqual({capability:'supported',source:'probe',checkedAt:200});
        expect(storage.save.mock.calls.at(-1)?.[0]).toEqual([{identity:createVisionProbeIdentity(base(),'deepseek','future-vision'),capability:'supported',checkedAt:200}]);
        await service.resolve(base(),'deepseek','future-vision',{probeUnknown:true}); expect(translate).toHaveBeenCalledOnce();
        now += VISION_PROBE_TTL_MS;
        await service.resolve(base(),'deepseek','future-vision',{probeUnknown:true}); expect(translate).toHaveBeenCalledTimes(2);
    });
    it('后台重启复用缓存，重新检测可覆盖内置规则但不修改用户设置', async () => {
        const source=base(), storage=store(), identity=createVisionProbeIdentity(source,'deepseek','deepseek-flash');
        storage.load.mockResolvedValue([{identity,capability:'unsupported',checkedAt:10}]);
        const translate=vi.fn(async()=> 'ABCDEF'); const service=createModelVisionProbe({storage,translate,random,now:()=>20});
        await expect(service.resolve(source,'deepseek','deepseek-flash')).resolves.toMatchObject({capability:'unsupported',source:'probe'});
        source.modelVision.deepseek={'deepseek-flash':false};
        await expect(service.resolve(source,'deepseek','deepseek-flash',{force:true})).resolves.toMatchObject({capability:'supported'});
        await expect(service.resolve(source,'deepseek','deepseek-flash')).resolves.toMatchObject({capability:'unsupported',source:'override'});
        expect(source.modelVision.deepseek['deepseek-flash']).toBe(false);
    });
    it('答案不匹配仍为未知；明确图片拒绝落盘；鉴权、限流和网络错误直接传播且不写负结论', async () => {
        const storage=store(), translate=vi.fn<() => Promise<string>>().mockResolvedValueOnce('UNKNOWN').mockRejectedValueOnce(Object.assign(new Error('HTTP 400'),{imageInputUnsupported:true}));
        const service=createModelVisionProbe({storage,translate,random});
        await expect(service.resolve(base(),'deepseek','future-vision',{force:true})).resolves.toEqual({capability:'unknown',source:'unknown'});
        expect(storage.save.mock.calls.at(-1)?.[0]).toEqual([]);
        await expect(service.resolve(base(),'deepseek','future-vision',{force:true})).resolves.toMatchObject({capability:'unsupported'});
        for(const error of [new Error('401'),new Error('429'),new Error('network')]) {
            translate.mockRejectedValueOnce(error);
            await expect(service.resolve(base(),'deepseek','future-vision',{force:true})).rejects.toBe(error);
            expect(storage.save.mock.calls.at(-1)?.[0]).toEqual([]);
        }
    });
    it('合并相同配置的并发探测，一个用户取消不影响其他用户', async () => {
        const wait=pending(), translate=vi.fn(async()=>wait.promise), storage=store(); const service=createModelVisionProbe({storage,translate,random});
        const a=new AbortController(); const first=service.resolve(base(),'deepseek','future-vision',{probeUnknown:true,signal:a.signal});
        const firstError=expect(first).rejects.toMatchObject({name:'AbortError'});
        const second=service.resolve(base(),'deepseek','future-vision',{probeUnknown:true});
        await vi.waitFor(()=>expect(translate).toHaveBeenCalledOnce()); a.abort(); await firstError;
        wait.resolve('ABCDEF'); await expect(second).resolves.toMatchObject({capability:'supported'});
    });
    it('取消或超时传播到真实请求，迟到结果不保存，之后可重试', async () => {
        vi.useFakeTimers(); const wait=pending(), storage=store(), translate=vi.fn(async()=>wait.promise); const service=createModelVisionProbe({storage,translate,random});
        const result=service.resolve(base(),'deepseek','future-vision',{probeUnknown:true,timeoutMs:10});
        const failure=expect(result).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(11); await failure;
        wait.resolve('ABCDEF'); await vi.advanceTimersByTimeAsync(1); expect(storage.save.mock.calls.at(-1)?.[0]).toEqual([]);
        translate.mockResolvedValueOnce('ABCDEF'); await expect(service.resolve(base(),'deepseek','future-vision',{force:true})).resolves.toMatchObject({capability:'supported'});
        const controller=new AbortController();controller.abort();
        await expect(service.resolve(base(),'deepseek','future-vision',{force:true,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    });
    it.each(['cancel', 'timeout'])('缓存加载挂起时仍遵守调用者 %s，迟到加载不启动探测', async (mode) => {
        vi.useFakeTimers();
        let finishLoad!: (value: unknown) => void;
        const storage = store();
        storage.load.mockImplementation(() => new Promise(resolve => {finishLoad = resolve;}));
        const translate = vi.fn(async () => 'ABCDEF');
        const service = createModelVisionProbe({storage, translate, random});
        const controller = new AbortController();
        let failure: unknown;
        const result = service.resolve(base(), 'deepseek', 'future-vision', {
            force: true, signal: controller.signal, timeoutMs: 10,
        }).catch(error => {failure = error;});
        if (mode === 'cancel') controller.abort();
        await vi.advanceTimersByTimeAsync(11);
        expect(failure).toMatchObject(mode === 'cancel' ? {name: 'AbortError'} : {message: expect.stringContaining('超时')});
        await result;
        expect(vi.getTimerCount()).toBe(0);
        finishLoad([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(translate).not.toHaveBeenCalled();
        expect(storage.save).not.toHaveBeenCalled();
        await expect(service.resolve(base(), 'deepseek', 'future-vision', {force: true})).resolves.toMatchObject({capability: 'supported'});
    });

    it('默认安全随机数可用，存储失败必须显示失败并且不绕过探测', async () => {
        const translate=vi.fn(async()=> 'UNKNOWN'), storage=store(); const service=createModelVisionProbe({storage,translate});
        await expect(service.resolve(base(),'deepseek','future-vision',{force:true})).resolves.toMatchObject({capability:'unknown'});
        const broken=store();broken.load.mockRejectedValue(new Error('storage failed'));
        await expect(createModelVisionProbe({storage:broken,translate}).resolve(base(),'deepseek','future-vision',{force:true})).rejects.toThrow('storage failed');
        const badWrite=store();badWrite.save.mockRejectedValueOnce(new Error('write failed'));
        const retry=createModelVisionProbe({storage:badWrite,translate,random});
        await expect(retry.resolve(base(),'deepseek','future-vision',{force:true})).rejects.toThrow('write failed');
        await expect(retry.resolve(base(),'deepseek','future-vision',{force:true})).resolves.toMatchObject({capability:'unknown'});
    });
    it('探测结果写入失败后，不应把未保存的结论当成缓存命中', async () => {
        const storage = store();
        storage.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('commit failed'));
        const translate = vi.fn(async () => 'ABCDEF');
        const service = createModelVisionProbe({storage, translate, random});
        await expect(service.resolve(base(), 'deepseek', 'future-vision', {force: true})).rejects.toThrow('commit failed');
        await expect(service.resolve(base(), 'deepseek', 'future-vision')).resolves.toEqual({capability: 'unknown', source: 'unknown'});
        expect(translate).toHaveBeenCalledOnce();
    });
    it('结果写入完成之前其他调用不能读取未提交的结论', async () => {
        let rejectWrite!: (error: Error) => void;
        const writing = new Promise<void>((_, reject) => {rejectWrite = reject;});
        const storage = store();
        storage.save.mockResolvedValueOnce(undefined).mockImplementationOnce(() => writing);
        const translate = vi.fn(async () => 'ABCDEF');
        const service = createModelVisionProbe({storage, translate, random});
        const attempt = service.resolve(base(), 'deepseek', 'future-vision', {force: true});
        const failure = expect(attempt).rejects.toThrow('commit failed');
        await vi.waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2));
        await expect(service.resolve(base(), 'deepseek', 'future-vision')).resolves.toEqual({capability: 'unknown', source: 'unknown'});
        rejectWrite(new Error('commit failed'));
        await failure;
    });
    it('强制重测正在清除旧缓存时，其他调用不能沿用旧结果', async () => {
        let finish!: () => void;
        const writing = new Promise<void>(resolve => {finish = resolve;});
        const source = base();
        const identity = createVisionProbeIdentity(source, 'deepseek', 'future-vision');
        const storage = store();
        storage.load.mockResolvedValue([{identity, capability: 'unsupported', checkedAt: 10}]);
        storage.save.mockImplementationOnce(() => writing);
        const translate = vi.fn(async () => 'ABCDEF');
        const service = createModelVisionProbe({storage, translate, random, now: () => 20});
        const attempt = service.resolve(source, 'deepseek', 'future-vision', {force: true});
        await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce());
        await expect(service.resolve(source, 'deepseek', 'future-vision')).resolves.toEqual({capability: 'unknown', source: 'unknown'});
        finish();
        await expect(attempt).resolves.toMatchObject({capability: 'supported'});
    });
    it.each(['failure', 'cancel'])('旧缓存清除写入 %s 后，旧结论不在当前实例重新出现', async mode => {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const writing = new Promise<void>((yes, no) => {resolve = yes; reject = no;});
        const source = base();
        const identity = createVisionProbeIdentity(source, 'deepseek', 'future-vision');
        const storage = store();
        storage.load.mockResolvedValue([{identity, capability: 'unsupported', checkedAt: 10}]);
        storage.save.mockImplementationOnce(() => writing);
        const service = createModelVisionProbe({storage, translate: vi.fn(async () => 'ABCDEF'), random, now: () => 20});
        const controller = new AbortController();
        const attempt = service.resolve(source, 'deepseek', 'future-vision', {force: true, signal: controller.signal});
        const failure = mode === 'failure' ? expect(attempt).rejects.toThrow('failed') : expect(attempt).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce());
        if (mode === 'failure') reject(new Error('failed'));
        else controller.abort();
        await failure;
        await expect(service.resolve(source, 'deepseek', 'future-vision')).resolves.toEqual({capability: 'unknown', source: 'unknown'});
        if (mode === 'cancel') resolve();
    });
    it('强制重测排队后取消，旧结论不会在同实例恢复', async () => {
        let finish!: () => void;
        const writing = new Promise<void>(resolve => {finish = resolve;});
        const storage = store();
        const source = base();
        const identity = createVisionProbeIdentity(source, 'deepseek', 'another-vision');
        let disk: unknown = [{identity, capability: 'supported', checkedAt: 10}];
        storage.load.mockImplementation(async () => disk);
        storage.save.mockImplementationOnce(async snapshot => {await writing; disk = snapshot;})
            .mockImplementation(async snapshot => {disk = snapshot;});
        const translate = vi.fn(async () => 'ABCDEF');
        const service = createModelVisionProbe({storage, translate, random, now: () => 20});
        const first = service.resolve(source, 'deepseek', 'future-vision', {force: true});
        await vi.waitFor(() => expect(storage.save).toHaveBeenCalledTimes(1));
        const controller = new AbortController();
        const attempt = service.resolve(source, 'deepseek', 'another-vision', {force: true, signal: controller.signal});
        const failure = expect(attempt).rejects.toMatchObject({name: 'AbortError'});
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.abort();
        await failure;
        finish();
        await first;
        await expect(service.resolve(source, 'deepseek', 'another-vision')).resolves.toEqual({capability: 'unknown', source: 'unknown'});
        const restarted = createModelVisionProbe({storage, translate, random, now: () => 20});
        // 另一身份的后续快照可能携带这次重测造成的旧缓存失效。
        await expect(restarted.resolve(source, 'deepseek', 'another-vision')).resolves.toEqual({capability: 'unknown', source: 'unknown'});
        expect(translate).toHaveBeenCalledTimes(1);
    });
    it('不同身份并发完成时，串行持久化不会覆盖先完成的结果', async () => {
        const storage = store();
        const translate = vi.fn(async () => 'ABCDEF');
        const service = createModelVisionProbe({storage, translate, random});
        const source = base();
        await Promise.all([
            service.resolve(source, 'deepseek', 'future-vision', {force: true}),
            service.resolve(source, 'deepseek', 'another-vision', {force: true}),
        ]);
        expect(storage.save.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining([
            expect.objectContaining({identity: createVisionProbeIdentity(source, 'deepseek', 'future-vision')}),
            expect.objectContaining({identity: createVisionProbeIdentity(source, 'deepseek', 'another-vision')}),
        ]));
        await expect(service.resolve(source, 'deepseek', 'future-vision')).resolves.toMatchObject({capability: 'supported'});
        await expect(service.resolve(source, 'deepseek', 'another-vision')).resolves.toMatchObject({capability: 'supported'});
        expect(translate).toHaveBeenCalledTimes(2);
    });
    it('提交在途取消不会发布到同实例，但已开始的存储写可能在重建后可见', async () => {
        let finish!: () => void;
        const writing = new Promise<void>(resolve => {finish = resolve;});
        let disk: unknown = [];
        let writes = 0;
        let committed!: () => void;
        const finished = new Promise<void>(resolve => {committed = resolve;});
        const storage = {
            load: vi.fn(async () => disk),
            save: vi.fn(async (snapshot: unknown) => {
                if (++writes === 2) await writing;
                disk = snapshot;
                if (writes === 2) committed();
            }),
        };
        const translate = vi.fn(async () => 'ABCDEF');
        const service = createModelVisionProbe({storage, translate, random});
        const controller = new AbortController();
        const attempt = service.resolve(base(), 'deepseek', 'future-vision', {force: true, signal: controller.signal});
        const failure = expect(attempt).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2));
        controller.abort();
        await failure;
        finish();
        await finished;
        await expect(service.resolve(base(), 'deepseek', 'future-vision')).resolves.toEqual({capability: 'unknown', source: 'unknown'});
        const restarted = createModelVisionProbe({storage, translate, random});
        await expect(restarted.resolve(base(), 'deepseek', 'future-vision')).resolves.toMatchObject({capability: 'supported'});
    });
});
