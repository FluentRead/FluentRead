import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
// 菜单所有权测试不启动真实配置存储；显式注入此跨模块端口，避免导入 UI 时产生无关存储告警。
vi.mock('@/src/services/config/store', () => ({config: {uiLanguage: 'zh-Hans'}}));
import {createVideoAiModelMenu} from '@/src/features/video-subtitle/content/video-ai/modelMenu';
import {createVideoAiModelSetup} from '@/src/features/video-subtitle/content/video-ai/modelSetup';

function setup() {
    const {document} = parseHTML('<body><div id="menu"><button data-action="model-prompt-confirm"></button><button data-model-choice="tiny"></button><button data-action="select-ai-model"></button></div></body>');
    const menu = document.getElementById('menu')!;
    menu.hidden = false;
    const confirm = menu.querySelector<HTMLButtonElement>('[data-action]')!;
    const selected = menu.querySelector<HTMLButtonElement>('[data-model-choice]')!;
    const returnButton = menu.querySelector<HTMLButtonElement>('[data-action="select-ai-model"]')!;
    confirm.focus = vi.fn();
    selected.focus = vi.fn();
    returnButton.focus = vi.fn();
    let current = true;
    let epoch = 1;
    let local = true;
    let canSelect = true;
    const start = vi.fn();
    const sendMessage = vi.fn(async (): Promise<unknown> => ({success: true, models: []}));
    const model = createVideoAiModelSetup({
        sendMessage, getConfiguredModel: () => 'tiny', captureRequest: () => () => current,
        persistModel: vi.fn(), startGeneration: start, setError: vi.fn(),
        formatDownloadError: error => error, watchDownload: () => () => undefined, onChange: vi.fn(),
    });
    const dependencies = {
        setup: model, isCurrent: () => current, mediaEpoch: () => epoch,
        restoreCache: vi.fn(async () => false), invalidateCache: vi.fn(),
        setRegenerating: vi.fn(), ensureEnabled: vi.fn(), supportsLocal: () => local,
        setError: vi.fn(), canSelect: () => canSelect,
    };
    const controller = createVideoAiModelMenu(dependencies);
    return {menu, confirm, selected, returnButton, start, model, sendMessage, dependencies, controller,
        invalidate: () => {current = false;}, switchMedia: () => {epoch += 1;},
        unsupported: () => {local = false;}, busy: () => {canSelect = false;}};
}

afterEach(() => vi.restoreAllMocks());

describe('video AI model menu ownership', () => {
    it('cache recovery enables captions without checking or downloading a model', async () => {
        const h = setup();
        h.dependencies.restoreCache.mockResolvedValue(true);
        await h.controller.request(h.menu);
        expect(h.dependencies.ensureEnabled).toHaveBeenCalledOnce();
        expect(h.dependencies.setRegenerating).toHaveBeenCalledWith(false);
        expect(h.sendMessage).not.toHaveBeenCalled();
        expect(h.start).not.toHaveBeenCalled();
    });

    it.each(['disposed', 'closed', 'media'] as const)('a late cache miss after %s cannot open the model choice', async (reason) => {
        const h = setup();
        let resolve!: (value: boolean) => void;
        h.dependencies.restoreCache.mockImplementation(() => new Promise(done => {resolve = done;}));
        const request = h.controller.request(h.menu);
        if (reason === 'disposed') h.invalidate();
        if (reason === 'closed') h.menu.hidden = true;
        if (reason === 'media') h.switchMedia();
        resolve(false);
        await request;
        expect(h.model.choice).toBeNull();
        expect(h.sendMessage).not.toHaveBeenCalled();
    });

    it('unsupported local inference displays an error after a genuine cache miss', async () => {
        const h = setup(); h.unsupported();
        await h.controller.request(h.menu);
        expect(h.dependencies.setError).toHaveBeenCalledWith('当前浏览器不支持本地 AI 字幕');
        expect(h.sendMessage).not.toHaveBeenCalled();
    });

    it('regeneration bypasses only subtitle restoration and focuses confirmation', async () => {
        const h = setup();
        await h.controller.request(h.menu, true);
        expect(h.dependencies.restoreCache).not.toHaveBeenCalled();
        expect(h.dependencies.setRegenerating).toHaveBeenCalledWith(true);
        expect(h.model.choice?.selected).toBe('tiny');
        expect(h.confirm.focus).toHaveBeenCalledOnce();
        expect(h.start).not.toHaveBeenCalled();
    });

    it('an already downloaded model starts without a confirmation focus change', async () => {
        const h = setup(); h.sendMessage.mockResolvedValue({success: true, models: ['tiny']});
        await h.controller.request(h.menu);
        expect(h.start).toHaveBeenCalledOnce();
        expect(h.confirm.focus).not.toHaveBeenCalled();
    });

    it.each(['disposed', 'closed', 'unsupported', 'busy'] as const)('explicit model selection while %s preserves the timeline and pending cache', async (reason) => {
        const h = setup();
        if (reason === 'disposed') h.invalidate();
        if (reason === 'closed') h.menu.hidden = true;
        if (reason === 'unsupported') h.unsupported();
        if (reason === 'busy') h.busy();
        await h.controller.select(h.menu);
        expect(h.dependencies.invalidateCache).not.toHaveBeenCalled();
        expect(h.dependencies.setRegenerating).not.toHaveBeenCalled();
        expect(h.sendMessage).not.toHaveBeenCalled();
    });

    it('explicit selection preserves cached captions until real confirmation, and focuses the current model', async () => {
        const h = setup(); h.sendMessage.mockResolvedValue({success: true, models: ['tiny']});
        await h.controller.select(h.menu);
        expect(h.dependencies.invalidateCache).toHaveBeenCalledOnce();
        expect(h.dependencies.restoreCache).not.toHaveBeenCalled();
        expect(h.model.choice?.purpose).toBe('selection');
        expect(h.selected.focus).toHaveBeenCalledOnce();
        expect(h.start).not.toHaveBeenCalled();
        h.model.cancel();
        expect(h.start).not.toHaveBeenCalled();
    });

    it('state-check failure does not focus a nonexistent model selection', async () => {
        const h = setup(); h.sendMessage.mockRejectedValue(new Error('offline'));
        await h.controller.select(h.menu);
        expect(h.model.choice).toBeNull();
        expect(h.selected.focus).not.toHaveBeenCalled();
    });

    it.each([false, true])('finish with confirmed=%s returns focus and starts only when confirmed', async (confirmed) => {
        const h = setup(); h.sendMessage.mockResolvedValue({success: true, models: ['tiny']});
        await h.controller.select(h.menu);
        h.controller.finish(h.menu, confirmed);
        expect(h.model.choice).toBeNull();
        expect(h.returnButton.focus).toHaveBeenCalledOnce();
        expect(h.start).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    });

    it('choosing another model preserves the explicit choice, tolerating an absent button', async () => {
        const h = setup();
        await h.controller.select(h.menu);
        h.controller.choose(h.menu, 'small');
        expect(h.model.choice?.selected).toBe('small');
        h.controller.choose(h.menu, 'tiny');
        expect(h.model.choice?.selected).toBe('tiny');
        expect(h.selected.focus).toHaveBeenCalledTimes(2);
    });

    it('a removed menu view tolerates missing focus destinations', async () => {
        const h = setup(); h.menu.replaceChildren();
        await h.controller.request(h.menu, true);
        h.model.cancel();
        await h.controller.select(h.menu);
        expect(h.model.choice?.purpose).toBe('selection');
    });
});
