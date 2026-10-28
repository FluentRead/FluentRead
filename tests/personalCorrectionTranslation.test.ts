import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const runtime = vi.hoisted(() => ({lookup: vi.fn(), provider: vi.fn()}));
vi.mock('@/src/services/personal-corrections/public', () => ({personalCorrections: {lookup: runtime.lookup}}));
vi.mock('@/src/features/full-page-translation/content/translationRequest', () => ({translateTextSlots: runtime.provider}));
vi.mock('@/src/services/config/store', () => ({config: {style: 0, to: 'zh', on: true, personalCorrectionsEnabled: true}}));
import {createTranslationRequest} from '@/src/features/full-page-translation/content/liveTextTranslation';
const snapshot = {service: 'microsoft', model: 'default', thinking: false, sourceLanguage: 'en', targetLanguage: 'zh',
    useCache: true, enableAIContext: false, enableAIMultiSegment: false, enableNativeBatch: true, displayMode: 'bilingual' as const, style: 0};
beforeEach(() => {
    const {document, window} = parseHTML('<html><body><h1>Team</h1><p>The team is ready.</p></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('location', {href: 'https://example.test/article'});
    runtime.lookup.mockReset().mockResolvedValue({suggestions: [], conflicts: []}); runtime.provider.mockReset().mockResolvedValue(['团队准备好了。']);
});
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});
describe('网页翻译在公共缓存之前精确复用个人记忆', () => {
    it('userscript 的普通双语请求不等待扩展记忆，也不生成个人快照', async () => {
        vi.stubEnv('BROWSER', 'userscript');
        expect(await createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot)).toEqual({kind: 'snapshot', sources: ['The team is ready.'], translations: ['团队准备好了。']});
        expect(runtime.lookup).not.toHaveBeenCalled(); expect(runtime.provider).toHaveBeenCalledOnce();
    });
    it('完全相同原句直接使用用户确认译文，重复请求仍不调用 provider', async () => {
        runtime.lookup.mockResolvedValue({exact: {id: 'personal', revision: 1, translation: '小组已就绪。'}});
        for (let i = 0; i < 2; i++) {
            const result = await createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot);
            expect(result).toMatchObject({kind: 'snapshot', sources: ['The team is ready.'], translations: ['小组已就绪。'],
                personalCorrection: {recordId: 'personal', recordRevision: 1, query: {context: 'Team', sourceLanguage: 'en', targetLanguage: 'zh'}}});
        }
        expect(runtime.provider).not.toHaveBeenCalled();
    });
    it('近似及冲突候选不自动替换；普通结果保留原服务底稿，删除后即时回滚', async () => {
        runtime.lookup.mockResolvedValue({suggestions: [{translation: '近似记忆'}], conflicts: [{translation: '冲突译法'}]});
        const result = await createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot);
        expect(result.translations).toEqual(['团队准备好了。']);
        expect(result.personalCorrection?.baseline).toEqual(['团队准备好了。']);
        expect(runtime.provider).toHaveBeenCalledOnce();
    });
    it('安全内联整段保持原槽映射；代码保护单元及仅译文控件维持现有请求', async () => {
        document.querySelector('p')!.innerHTML = 'The <strong>team</strong> is ready.';
        runtime.lookup.mockResolvedValue({exact: {id: 'personal', revision: 1, translation: '小组已就绪。'}});
        const result = await createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot);
        expect(result.translations).toEqual(['小组已就绪。', '', '']);
        expect(runtime.provider).not.toHaveBeenCalled();
        document.querySelector('p')!.innerHTML = 'Use <code>team.ready</code> now.';
        runtime.lookup.mockClear(); await createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot);
        expect(runtime.lookup).not.toHaveBeenCalled(); expect(runtime.provider).toHaveBeenCalled();
        runtime.lookup.mockClear(); await createTranslationRequest(document.querySelector('p')!, 'content', 'single', snapshot);
        expect(runtime.lookup).not.toHaveBeenCalled();
    });
    it('记忆读取失败沿用普通翻译，不把未知个人结果缓存', async () => {
        runtime.lookup.mockRejectedValue(Error('memory unavailable'));
        expect(await createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot)).toMatchObject({translations: ['团队准备好了。']});
        expect(runtime.provider).toHaveBeenCalledOnce();
    });

    it.each(['resolve', 'reject'] as const)('翻译初查期间取消，迟到的校订 %s 不触发服务请求', async outcome => {
        const controller = new AbortController();
        let resolve!: (value: unknown) => void;
        let reject!: (error: unknown) => void;
        runtime.lookup.mockReturnValueOnce(new Promise((done, fail) => {resolve = done;reject = fail;}));
        const request = createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot, controller.signal);
        const cancelled = expect(request).rejects.toMatchObject({name: 'AbortError'});
        expect(runtime.lookup).toHaveBeenCalledOnce();
        controller.abort();
        if (outcome === 'resolve') resolve({exact: {id: 'late', revision: 1, translation: '过期译文'}});
        else reject(new Error('late storage failure'));
        await cancelled;
        expect(runtime.provider).not.toHaveBeenCalled();
    });

    it('带未取消信号的成功校订仍直接复用，缺少信号的查询失败继续使用服务翻译', async () => {
        const controller = new AbortController();
        runtime.lookup.mockResolvedValueOnce({exact: {id: 'saved', revision: 1, translation: '已确认译文'}})
            .mockRejectedValueOnce(new Error('memory unavailable'));
        await expect(createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot, controller.signal))
            .resolves.toMatchObject({translations: ['已确认译文']});
        expect(runtime.provider).not.toHaveBeenCalled();
        await expect(createTranslationRequest(document.querySelector('p')!, 'content', 'bilingual', snapshot))
            .resolves.toMatchObject({translations: ['团队准备好了。']});
        expect(runtime.provider).toHaveBeenCalledOnce();
    });
});
