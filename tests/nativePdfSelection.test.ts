/**
 * @file tests/nativePdfSelection.test.ts
 * 文件职责：验证原生 PDF 菜单原文的一次性窗口交付及后台装配。
 * 主要内容：用受控窗口创建和时钟覆盖首次兑换竞态、来源与目标校验、并发重放、过期、容量回收、失败和不落盘契约。
 * 模块边界：执行实际 feature 与 app 组合，只替换浏览器窗口端口；不访问 PDF 文件或翻译供应商。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createNativePdfSelectionBridge, NATIVE_PDF_SELECTION_TTL_MS, type NativePdfSelectionDependencies, type NativePdfSelectionInput, type NativePdfSelectionSender} from '@/src/features/selection-translation/background/nativePdfSelection';

const PAGE = 'chrome-extension://test/selection.html';
const INPUT = {text: 'cache\n  coherence', sourceUrl: 'https://www.usenix.org/paper.pdf?download=1#page=2', title: 'FAST paper'};
const TOKEN = '00000000000000000000000000000001';
const SENDER: NativePdfSelectionSender = {id: 'test', url: PAGE, frameId: 0, tab: {id: 21, windowId: 12}};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
async function settle() {for (let at = 0; at < 12; at++) await Promise.resolve();}
function fixture(overrides: Partial<NativePdfSelectionDependencies> = {}) {
    let time = 1_000, sequence = 0;
    const dependencies = {extensionId: 'test', resultUrl: PAGE, now: () => time, wallNow: () => time,
        randomToken: vi.fn(() => (++sequence).toString(16).padStart(32, '0')),
        openWindow: vi.fn<NativePdfSelectionDependencies['openWindow']>().mockResolvedValue({id: 12, tabs: [{id: 21, windowId: 12}]}),
        ...overrides};
    return {...dependencies, bridge: createNativePdfSelectionBridge(dependencies), advance: (ms: number) => {time += ms;}};
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('原生 PDF 菜单选区的一次性窗口交付', () => {
    it('仅在独立小窗口地址放随机票据，原文内部空白准确保留，来源剔除 fragment', async () => {
        const run = fixture({resultUrl: `${PAGE}?old=1#stale`});
        expect(await run.bridge.open({...INPUT, text: ` \n${INPUT.text}\t `, title: ' FAST paper '})).toBe(true);
        expect(run.openWindow).toHaveBeenCalledTimes(1);
        expect(run.openWindow).toHaveBeenCalledWith({url: `${PAGE}#token=${TOKEN}`, type: 'popup', width: 520, height: 680});
        expect(await run.bridge.claim(TOKEN, SENDER)).toEqual({...INPUT, sourceUrl: 'https://www.usenix.org/paper.pdf?download=1'});
        expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
    });
    it.each([
        {text: ''}, {text: ' \n\t'}, {text: 'x'.repeat(4097)}, {text: undefined}, {sourceUrl: 'file:///tmp/paper.pdf'},
        {sourceUrl: 'https://user:secret@example.com/paper.pdf'}, {sourceUrl: 'invalid'}, {sourceUrl: undefined}, {title: undefined},
    ])('非法输入 %j 不创建窗口也不签票', async change => {
        const run = fixture(); expect(await run.bridge.open({...INPUT, ...change} as NativePdfSelectionInput)).toBe(false);
        expect(run.openWindow).not.toHaveBeenCalled(); expect(run.randomToken).not.toHaveBeenCalled();
    });
    it('支持正好 4096 字和无后缀 HTTP 来源；长标题仅保留 512 字', async () => {
        const run = fixture(); expect(await run.bridge.open({text: 'x'.repeat(4096), sourceUrl: 'http://example.com/download?id=9', title: 't'.repeat(600)})).toBe(true);
        expect(await run.bridge.claim(TOKEN, SENDER)).toEqual({text: 'x'.repeat(4096), sourceUrl: 'http://example.com/download?id=9', title: 't'.repeat(512)});
    });
    it.each([undefined, null, 1, 'unknown'])('未知票据 %s 不泄漏正文', async token => {const run = fixture(); await run.bridge.open(INPUT); expect(await run.bridge.claim(token, SENDER)).toBeNull();});
    it.each([
        undefined, {...SENDER, id: 'foreign'}, {...SENDER, url: undefined}, {...SENDER, url: 'https://test/selection.html'},
        {...SENDER, url: 'chrome-extension://other/selection.html'}, {...SENDER, url: `${PAGE}/nested`}, {...SENDER, url: `${PAGE}.evil`},
        {...SENDER, frameId: undefined}, {...SENDER, frameId: 1}, {...SENDER, tab: undefined}, {...SENDER, tab: {id: 22, windowId: 12}}, {...SENDER, tab: {id: 21, windowId: 13}},
    ])('拒绝来源或目标不符的发送方 %j，同时保留合法窗口兑换权', async sender => {
        const run = fixture(); await run.bridge.open(INPUT); expect(await run.bridge.claim(TOKEN, sender)).toBeNull(); expect(await run.bridge.claim(TOKEN, SENDER)).not.toBeNull();
    });
    it('结果页已清除 hash 或保留参数时按精确页面和目标身份校验', async () => {
        const run = fixture(); await run.bridge.open(INPUT); expect(await run.bridge.claim(TOKEN, {...SENDER, url: `${PAGE}?layout=compact#different`})).not.toBeNull();
    });
    it.each([{id: 12}, {id: 12, tabs: []}, {id: 12, tabs: [{}]}])('浏览器没有返回标签 ID 时绑定目标 windowId %j', async window => {
        const run = fixture({openWindow: vi.fn().mockResolvedValue(window)}); await run.bridge.open(INPUT);
        expect(await run.bridge.claim(TOKEN, {...SENDER, tab: {windowId: 99}})).toBeNull();
        expect(await run.bridge.claim(TOKEN, {...SENDER, tab: {windowId: 12}})).not.toBeNull();
    });
    it('页面先请求兑换时等待窗口创建身份落地，并发领取只有一个成功', async () => {
        const window = deferred<{id: number; tabs: {id: number}[]}>(), run = fixture({openWindow: vi.fn().mockReturnValue(window.promise)});
        const opened = run.bridge.open(INPUT), first = run.bridge.claim(TOKEN, SENDER), second = run.bridge.claim(TOKEN, SENDER);
        let settled = false; void first.then(() => {settled = true;}); await settle(); expect(settled).toBe(false);
        window.resolve({id: 12, tabs: [{id: 21}]}); expect(await opened).toBe(true);
        expect(await first).not.toBeNull(); expect(await second).toBeNull();
    });
    it('创建期间错误窗口提前领取，创建后仍按最终窗口身份拒绝', async () => {
        const window = deferred<{id: number}>(), run = fixture({openWindow: vi.fn().mockReturnValue(window.promise)});
        const opened = run.bridge.open(INPUT), wrong = run.bridge.claim(TOKEN, {...SENDER, tab: {windowId: 99}});
        window.resolve({id: 12}); await opened; expect(await wrong).toBeNull(); expect(await run.bridge.claim(TOKEN, SENDER)).not.toBeNull();
    });
    it('到期票据无法领取', async () => {
        const run = fixture(); await run.bridge.open(INPUT);
        run.advance(NATIVE_PDF_SELECTION_TTL_MS); expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull(); await settle();
    });
    it('创建等待跨过到期时间，迟到窗口保留且不能领取', async () => {
        const window = deferred<{id: number}>(), run = fixture({openWindow: vi.fn().mockReturnValue(window.promise)});
        const opened = run.bridge.open(INPUT), claim = run.bridge.claim(TOKEN, SENDER); await settle(); run.advance(NATIVE_PDF_SELECTION_TTL_MS);
        window.resolve({id: 12}); expect(await opened).toBe(false); expect(await claim).toBeNull(); await settle();
    });
    it('兑换开始后票据才到期，异步等待不能延长交付有效期', async () => {
        const run = fixture(); await run.bridge.open(INPUT);
        const claim = run.bridge.claim(TOKEN, SENDER); run.advance(NATIVE_PDF_SELECTION_TTL_MS);
        expect(await claim).toBeNull();
    });
    it('等待创建的票据过期后，迟到窗口不能污染新票据', async () => {
        const window = deferred<{id: number}>(), run = fixture({openWindow: vi.fn().mockReturnValueOnce(window.promise).mockResolvedValue({id: 13})});
        const old = run.bridge.open(INPUT); await settle(); run.advance(NATIVE_PDF_SELECTION_TTL_MS); expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
        expect(await run.bridge.open(INPUT)).toBe(true); window.resolve({id: 12}); expect(await old).toBe(false); await settle();
        expect(await run.bridge.claim('00000000000000000000000000000002', {...SENDER, tab: {windowId: 13}})).not.toBeNull();
    });
    it.each([undefined, -1, 1.5, NaN])('窗口身份 %s 不完整时不发出可兑换票据', async id => {
        const run = fixture({openWindow: vi.fn().mockResolvedValue({id})}); expect(await run.bridge.open(INPUT)).toBe(false); expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
    });
    it('创建失败向菜单返回 false，等待中的领取也返回 null', async () => {
        const window = deferred<never>(), run = fixture({openWindow: vi.fn().mockReturnValue(window.promise)});
        const opened = run.bridge.open(INPUT), claim = run.bridge.claim(TOKEN, SENDER); window.reject(new Error('popup unavailable'));
        expect(await opened).toBe(false); expect(await claim).toBeNull();
    });
    it('签票时清理过期票据，新票据仍可交付', async () => {
        const run = fixture(); await run.bridge.open(INPUT); run.advance(NATIVE_PDF_SELECTION_TTL_MS);
        expect(await run.bridge.open(INPUT)).toBe(true); expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
    });
    it('主动到期清除未领取票据，保留可能已被用户导航的窗口', async () => {
        vi.useFakeTimers();
        try {
            const run = fixture();
            await run.bridge.open(INPUT);expect(vi.getTimerCount()).toBe(1);run.advance(NATIVE_PDF_SELECTION_TTL_MS);
            await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(vi.getTimerCount()).toBe(0);expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
        } finally {vi.useRealTimers();}
    });

    it('窗口创建挂起时到期释放打开和领取，迟到窗口保留', async () => {
        vi.useFakeTimers();
        try {
            const window = deferred<{id: number}>();
            const run = fixture({openWindow: vi.fn().mockReturnValue(window.promise)});
            const opened = run.bridge.open(INPUT), claim = run.bridge.claim(TOKEN, SENDER);await settle();
            run.advance(NATIVE_PDF_SELECTION_TTL_MS);await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(await opened).toBe(false);expect(await claim).toBeNull();
            window.resolve({id:12});await settle();expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
        } finally {vi.useRealTimers();}
    });

    it('主动过期后消费窗口创建的迟到失败', async () => {
        vi.useFakeTimers();
        try {
            const window = deferred<never>(), run = fixture({openWindow: vi.fn().mockReturnValue(window.promise)});
            const opened = run.bridge.open(INPUT);await settle();run.advance(NATIVE_PDF_SELECTION_TTL_MS);
            await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);expect(await opened).toBe(false);
            window.reject(new Error('late failure'));await settle();
        } finally {vi.useRealTimers();}
    });

    it('成功领取后撤销到期清理，不关闭用户的结果窗口', async () => {
        vi.useFakeTimers();
        try {
            const run = fixture();
            await run.bridge.open(INPUT);expect(await run.bridge.claim(TOKEN, SENDER)).not.toBeNull();
            run.advance(NATIVE_PDF_SELECTION_TTL_MS);await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('旧计时回调迟到时不能清除碰巧复用相同令牌的新票据', async () => {
        vi.useFakeTimers();
        try {
            const setTimer = vi.spyOn(globalThis, 'setTimeout'), run = fixture({randomToken: () => TOKEN});
            await run.bridge.open(INPUT);const stale = setTimer.mock.calls[0][0] as () => void;
            expect(await run.bridge.claim(TOKEN, SENDER)).not.toBeNull();
            await run.bridge.open({...INPUT, text:'new'});stale();
            expect((await run.bridge.claim(TOKEN, SENDER))?.text).toBe('new');expect(vi.getTimerCount()).toBe(0);
        } finally {vi.restoreAllMocks();vi.useRealTimers();}
    });

    it('系统时钟回退时重新安排剩余有效期', async () => {
        vi.useFakeTimers();
        try {
            const run = fixture();
            await run.bridge.open(INPUT);await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(vi.getTimerCount()).toBe(1);
            run.advance(NATIVE_PDF_SELECTION_TTL_MS);await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(vi.getTimerCount()).toBe(0);expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
        } finally {vi.useRealTimers();}
    });

    it('异常时钟大幅回退不会把长计时钳成频繁唤醒', async () => {
        vi.useFakeTimers();
        try {
            const timer = vi.spyOn(globalThis, 'setTimeout'), run = fixture();
            await run.bridge.open(INPUT);run.advance(-3_000_000_000);
            await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(timer.mock.lastCall?.[1]).toBe(2_147_483_647);expect(vi.getTimerCount()).toBe(1);
            run.advance(3_000_000_000 + NATIVE_PDF_SELECTION_TTL_MS);
            await vi.advanceTimersByTimeAsync(2_147_483_647);
            expect(vi.getTimerCount()).toBe(0);expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
        } finally {vi.restoreAllMocks();vi.useRealTimers();}
    });

    it('墙钟先快进再回拨时，单调截止点仍限制新票据', async () => {
        let monotonic = 0, wall = 86_400_000;
        const run = fixture({now:() => monotonic, wallNow:() => wall});
        await run.bridge.open(INPUT);wall = 0;monotonic = NATIVE_PDF_SELECTION_TTL_MS;
        expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
    });

    it('容量超过十六条时只淘汰最旧票据，不关闭用户窗口', async () => {
        const run = fixture();
        for (let at = 0; at < 17; at++) expect(await run.bridge.open({...INPUT, text: `selection ${at}`})).toBe(true);
         expect(await run.bridge.claim(TOKEN, SENDER)).toBeNull();
        expect((await run.bridge.claim('00000000000000000000000000000011', SENDER))?.text).toBe('selection 16');
    });
    it('并发超额时不再启动已淘汰票据的窗口创建', async () => {
        vi.useFakeTimers();
        try {
            const run = fixture();const results = await Promise.all(Array.from({length:17}, () => run.bridge.open(INPUT)));
            expect(results.filter(Boolean)).toHaveLength(16);expect(run.openWindow).toHaveBeenCalledTimes(16);
            run.advance(NATIVE_PDF_SELECTION_TTL_MS);await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
    it('限制无法取消的挂起窗口创建，迟到结束后释放容量', async () => {
        vi.useFakeTimers();
        try {
            const pending = Array.from({length:16}, () => deferred<{id:number}>());let count = 0;
            const openWindow = vi.fn(() => count < pending.length ? pending[count++].promise : Promise.resolve({id:99}));
            const run = fixture({openWindow});const requests = pending.map(() => run.bridge.open(INPUT));await settle();
            expect(openWindow).toHaveBeenCalledTimes(16);run.advance(NATIVE_PDF_SELECTION_TTL_MS);
            await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(await Promise.all(requests)).toEqual(Array(16).fill(false));
            expect(await run.bridge.open(INPUT)).toBe(false);expect(openWindow).toHaveBeenCalledTimes(16);
            pending[0].resolve({id:12});await settle();expect(await run.bridge.open(INPUT)).toBe(true);
            for (const request of pending.slice(1)) request.reject(new Error('late'));
            await settle();run.advance(NATIVE_PDF_SELECTION_TTL_MS);await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
    it('容量淘汰尚在创建的票据，迟到的窗口仍保留', async () => {
        const firstWindow = deferred<{id: number}>(), run = fixture({openWindow: vi.fn().mockReturnValueOnce(firstWindow.promise).mockResolvedValue({id: 13})});
        const first = run.bridge.open(INPUT); await settle(); for (let at = 0; at < 16; at++) await run.bridge.open(INPUT);
        firstWindow.resolve({id: 12}); expect(await first).toBe(false); await settle();
    });
    it.each(['', 'predictable', 'x'.repeat(32)])('随机数端口返回非法 token %s 不创建结果页', async token => {
        const run = fixture({randomToken: () => token}); expect(await run.bridge.open(INPUT)).toBe(false); expect(run.openWindow).not.toHaveBeenCalled();
    });
    it('随机票据碰撞不覆盖已等待领取的原文', async () => {
        const run = fixture({randomToken: () => TOKEN}); await run.bridge.open(INPUT); expect(await run.bridge.open({...INPUT, text: 'replacement'})).toBe(false);
        expect((await run.bridge.claim(TOKEN, SENDER))?.text).toBe(INPUT.text);
    });
});

describe('后台原生 PDF bridge 的懒加载装配', () => {
    it('超长提示与正常选区共用窗口创建上限，迟到结束后恢复', async () => {
        vi.resetModules();const pending=Array.from({length:16},() => deferred<{id:number}>());let count=0;
        const create=vi.fn(() => count<pending.length ? pending[count++].promise : Promise.resolve({id:12}));
        vi.stubGlobal('browser',{runtime:{id:'test',getURL:() => PAGE},windows:{create}});
        vi.stubGlobal('crypto',{getRandomValues:(bytes:Uint8Array) => {bytes.fill(0);bytes[15]=1;return bytes;}});
        const module=await import('@/src/app/background/nativePdfSelection');
        const requests=pending.map(() => module.openNativePdfSelection({...INPUT,text:'x'.repeat(4097)}));await settle();
        expect(create).toHaveBeenCalledTimes(16);
        expect(await module.openNativePdfSelection({...INPUT,text:'x'.repeat(4097)})).toBe(false);
        expect(await module.openNativePdfSelection(INPUT)).toBe(false);expect(create).toHaveBeenCalledTimes(16);
        pending[0].resolve({id:12});expect(await requests[0]).toBe(true);
        expect(await module.openNativePdfSelection({...INPUT,text:'x'.repeat(4097)})).toBe(true);
        for(const request of pending.slice(1))request.reject(new Error('late'));await Promise.all(requests);
    });
    it.each([true, false])('超长原文仅打开无正文无来源的错误窗口，创建成功 %s 如实返回', async opened => {
        vi.resetModules(); const create = vi.fn();
        if (opened) create.mockResolvedValue({id: 12}); else create.mockRejectedValue(new Error('window blocked'));
        const api = {runtime: {getURL: vi.fn(() => PAGE)}, windows: {create}}; vi.stubGlobal('browser', api);
        const module = await import('@/src/app/background/nativePdfSelection');
        expect(await module.openNativePdfSelection({...INPUT, text: 'private text '.repeat(400)})).toBe(opened);
        expect(create).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledWith({url: `${PAGE}#error=too-long`, type: 'popup', width: 520, height: 680});
        expect(api.runtime.getURL).toHaveBeenCalledTimes(1);
    });
    it('非字符串选区继续由原有输入边界拒绝，不新开错误窗口', async () => {
        vi.resetModules(); const api = {runtime: {id: 'test', getURL: () => PAGE}, windows: {create: vi.fn()}}; vi.stubGlobal('browser', api);
        const module = await import('@/src/app/background/nativePdfSelection');
        expect(await module.openNativePdfSelection({...INPUT, text: undefined} as unknown as NativePdfSelectionInput)).toBe(false);
        expect(api.windows.create).not.toHaveBeenCalled();
    });
    it('导入和创建 handler 均不访问 browser；首次菜单打开才装配，同实例兑换', async () => {
        vi.resetModules(); vi.stubGlobal('browser', undefined);
        const module = await import('@/src/app/background/nativePdfSelection'); const handler = module.createNativePdfSelectionHandler<{sender: NativePdfSelectionSender}>();
        expect(handler.type).toBe('claimNativePdfSelection');
        const api = {runtime: {id: 'test', getURL: vi.fn(() => PAGE)}, windows: {create: vi.fn().mockResolvedValue({id: 12, tabs: [{id: 21}]}), remove: vi.fn().mockResolvedValue(undefined)}};
        vi.stubGlobal('browser', api); vi.stubGlobal('crypto', {getRandomValues: (bytes: Uint8Array) => {bytes.fill(0); bytes[15] = 1; return bytes;}});
        expect(await module.openNativePdfSelection(INPUT)).toBe(true); expect(api.runtime.getURL).toHaveBeenCalledTimes(1);
        expect(await handler.handle({type: 'claimNativePdfSelection', token: TOKEN} as any, {sender: SENDER})).toEqual({...INPUT, sourceUrl: 'https://www.usenix.org/paper.pdf?download=1'});
        expect(await handler.handle({type: 'claimNativePdfSelection', token: TOKEN} as any, {sender: SENDER})).toBeNull();
    });
    it('后台重启或调用上下文缺失时返回 null，过期不关闭用户窗口', async () => {
        vi.resetModules(); const api = {runtime: {id: 'test', getURL: () => PAGE}, windows: {create: vi.fn().mockResolvedValue({id: 12}), remove: vi.fn().mockResolvedValue(undefined)}};
        vi.stubGlobal('browser', api); vi.stubGlobal('crypto', {getRandomValues: (bytes: Uint8Array) => {bytes.fill(0); bytes[15] = 1; return bytes;}});
        const time = vi.spyOn(performance, 'now').mockReturnValue(0), module = await import('@/src/app/background/nativePdfSelection'), handler = module.createNativePdfSelectionHandler();
        expect(await handler.handle({type: 'claimNativePdfSelection'}, undefined)).toBeNull(); await module.openNativePdfSelection(INPUT);
        time.mockReturnValue(NATIVE_PDF_SELECTION_TTL_MS); expect(await handler.handle({type: 'claimNativePdfSelection', token: TOKEN} as any, {sender: SENDER})).toBeNull();
        expect(api.windows.remove).not.toHaveBeenCalled(); time.mockRestore();
    });
    it('单调时钟暂停时仍按经过的墙钟时间拒绝过期领取', async () => {
        vi.resetModules();const api = {runtime:{id:'test',getURL:() => PAGE},windows:{create:vi.fn().mockResolvedValue({id:12}),remove:vi.fn()}};
        vi.stubGlobal('browser',api);vi.stubGlobal('crypto',{getRandomValues:(bytes:Uint8Array) => {bytes.fill(0);bytes[15]=1;return bytes;}});
        const monotonic=vi.spyOn(performance,'now').mockReturnValue(0),wall=vi.spyOn(Date,'now').mockReturnValue(1000);
        try {
            const module=await import('@/src/app/background/nativePdfSelection');expect(await module.openNativePdfSelection(INPUT)).toBe(true);
            wall.mockReturnValue(1000+NATIVE_PDF_SELECTION_TTL_MS);
            expect(await module.createNativePdfSelectionHandler().handle({type:'claimNativePdfSelection',token:TOKEN} as any,{sender:SENDER})).toBeNull();
            expect(api.windows.remove).not.toHaveBeenCalled();
        } finally {monotonic.mockRestore();wall.mockRestore();}
    });
    it('容量淘汰与到期都不会关闭可能已被用户接管的真实窗口端口', async () => {
        vi.useFakeTimers();
        try {
            vi.resetModules();let sequence = 0;
            const api = {runtime:{id:'test',getURL:() => PAGE}, windows:{create:vi.fn().mockResolvedValue({id:12}), remove:vi.fn()}};
            vi.stubGlobal('browser', api);vi.stubGlobal('crypto', {getRandomValues:(bytes:Uint8Array) => {bytes.fill(0);bytes[15]=++sequence;return bytes;}});
            const module = await import('@/src/app/background/nativePdfSelection');
            for (let at = 0; at < 17; at++) expect(await module.openNativePdfSelection(INPUT)).toBe(true);
            expect(api.windows.remove).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            expect(api.windows.remove).not.toHaveBeenCalled();
        } finally {vi.useRealTimers();}
    });
});
