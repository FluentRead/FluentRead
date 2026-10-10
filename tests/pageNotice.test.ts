import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';

import {sendErrorMessage, showPageNotice, dismissPageNotice} from '@/src/features/page-notice/public';
import {config} from '@/src/services/config/store';
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalBrowser = (globalThis as typeof globalThis & {browser?: unknown}).browser;

const sendMessage = vi.fn(async () => ({success: true}));
const noticeCss = readFileSync(new URL('../src/features/page-notice/content/notice.css', import.meta.url), 'utf8');
const originalTheme = config.theme;

function noticeEvent(node: Element, type: string, properties: Record<string, unknown> = {}): Event {
    const event = new window.Event(type, {bubbles: true, cancelable: true});
    Object.assign(event, properties);
    node.dispatchEvent(event);
    return event;
}

describe('page error notice', () => {
    it('成功开始后按功能 key 清理旧提示，保留其他通知且空 key 或不存在的 key 无副作用', async () => {
        const retry = showPageNotice('选区失效', 'error', {key: 'context-menu'});
        const unrelated = showPageNotice('独立反馈', 'success', {key: 'copy'});
        const anonymous = showPageNotice('无所属反馈', 'error');await Promise.resolve();
        dismissPageNotice('');dismissPageNotice('missing');expect(vi.getTimerCount()).toBe(3);
        noticeEvent(retry, 'mouseenter');expect(vi.getTimerCount()).toBe(2);
        dismissPageNotice('context-menu');dismissPageNotice('context-menu');
        expect(retry.classList.contains('is-leaving')).toBe(true);expect(vi.getTimerCount()).toBe(3);
        await vi.advanceTimersByTimeAsync(180);expect(retry.isConnected).toBe(false);
        expect(unrelated.isConnected).toBe(true);expect(anonymous.isConnected).toBe(true);expect(vi.getTimerCount()).toBe(2);
        noticeEvent(retry, 'mouseleave');expect(vi.getTimerCount()).toBe(2);
    });
    it('未显示任何通知时撤销 key 不创建宿主或任务', () => {
        dismissPageNotice('context-menu');expect(document.getElementById('fluent-read-page-notice-host')).toBeNull();expect(vi.getTimerCount()).toBe(0);
    });
    it('悬停暂停自动关闭，离开后按剩余时间恢复且保持一个计时器', async () => {
        const notice = showPageNotice('正在阅读详情', 'error');await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1000);
        noticeEvent(notice, 'mouseenter');noticeEvent(notice, 'mouseenter');
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);expect(notice.isConnected).toBe(true);
        noticeEvent(notice, 'mouseleave');noticeEvent(notice, 'mouseleave');
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(2499);expect(notice.classList.contains('is-leaving')).toBe(false);
        await vi.advanceTimersByTimeAsync(1);expect(notice.classList.contains('is-leaving')).toBe(true);
        await vi.advanceTimersByTimeAsync(180);expect(notice.isConnected).toBe(false);expect(vi.getTimerCount()).toBe(0);
    });
    it('到期前悬停离开仍有最少阅读余量，关闭动画中的交互不能重新计时', async () => {
        const notice = showPageNotice('详情', 'error');await Promise.resolve();
        await vi.advanceTimersByTimeAsync(3400);noticeEvent(notice, 'mouseenter');noticeEvent(notice, 'mouseleave');
        await vi.advanceTimersByTimeAsync(1499);expect(notice.classList.contains('is-leaving')).toBe(false);
        await vi.advanceTimersByTimeAsync(1);noticeEvent(notice, 'mouseenter');noticeEvent(notice, 'mouseleave');
        expect(vi.getTimerCount()).toBe(1);await vi.advanceTimersByTimeAsync(180);expect(notice.isConnected).toBe(false);
    });
    it('键盘焦点和悬停独立暂停，在通知内部移动焦点不恢复倒计时', async () => {
        const notice = showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error');await Promise.resolve();
        const action = notice.querySelector('.notice-action')!, close = notice.querySelector('.notice-close')!;
        noticeEvent(action, 'focusin', {relatedTarget: null});noticeEvent(notice, 'mouseenter');
        noticeEvent(action, 'focusout', {relatedTarget: close});noticeEvent(close, 'focusin', {relatedTarget: action});
        noticeEvent(notice, 'mouseleave');expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(20_000);expect(notice.isConnected).toBe(true);
        noticeEvent(close, 'focusout', {relatedTarget: null});expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(6500 + 180);expect(notice.isConnected).toBe(false);
    });
    it('停留期间同 key 只更新当前通知，保持可见且从最新阅读时长恢复', async () => {
        const notice = showPageNotice('第一条详情', 'error', {key: 'context-menu', durationMs: 6000});
        noticeEvent(notice, 'mouseenter');await Promise.resolve();
        expect(notice.classList.contains('is-visible')).toBe(true);expect(vi.getTimerCount()).toBe(0);
        for (let index = 0; index < 100; index++) expect(showPageNotice(`新详情 ${index}`, 'error', {key: 'context-menu', durationMs: 6000})).toBe(notice);
        await vi.advanceTimersByTimeAsync(20_000);expect(notice.textContent).toContain('新详情 99');expect(vi.getTimerCount()).toBe(0);
        noticeEvent(notice, 'mouseleave');expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(5999);expect(notice.classList.contains('is-leaving')).toBe(false);
        await vi.advanceTimersByTimeAsync(181);expect(notice.isConnected).toBe(false);
    });
    it('暂停时关闭按钮仍清理通知，abort 即时清理任务和交互监听', async () => {
        const closed = showPageNotice('可关闭', 'success');noticeEvent(closed, 'mouseenter');
        closed.querySelector<HTMLButtonElement>('.notice-close')!.click();expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(180);expect(closed.isConnected).toBe(false);
        const controller = new AbortController();const aborted = showPageNotice('可取消', 'error', {signal: controller.signal});
        noticeEvent(aborted, 'focusin', {relatedTarget: null});
        const removeListener = vi.spyOn(aborted, 'removeEventListener');controller.abort();
        expect(aborted.isConnected).toBe(false);expect(vi.getTimerCount()).toBe(0);expect(removeListener).toHaveBeenCalledTimes(5);
        noticeEvent(aborted, 'mouseleave');noticeEvent(aborted, 'focusout', {relatedTarget: null});
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['hover', 'focus'] as const)('关闭动画期间 %s 离开后，同 key 再次反馈正常恢复倒计时', async interaction => {
        const previous = document.createElement('button');document.body.appendChild(previous);
        Object.defineProperty(document, 'activeElement', {value: previous, configurable: true});
        const notice = showPageNotice('第一次反馈', 'error', {key: 'revive'});await Promise.resolve();
        const close = notice.querySelector<HTMLButtonElement>('.notice-close')!;
        if (interaction === 'hover') noticeEvent(notice, 'mouseenter');
        else {
            noticeEvent(close, 'focusin', {relatedTarget: previous});
            Object.defineProperty(document, 'activeElement', {value: close, configurable: true});
            vi.spyOn(previous, 'focus').mockImplementation(() => {
                Object.defineProperty(document, 'activeElement', {value: previous, configurable: true});
                noticeEvent(close, 'focusout', {relatedTarget: previous});
            });
        }
        close.click();
        if (interaction === 'hover') noticeEvent(notice, 'mouseleave');
        expect(vi.getTimerCount()).toBe(1);
        expect(showPageNotice('再次反馈', 'error', {key: 'revive'})).toBe(notice);
        expect(vi.getTimerCount()).toBe(1);await vi.advanceTimersByTimeAsync(3500 + 180);
        expect(notice.isConnected).toBe(false);expect(vi.getTimerCount()).toBe(0);
    });
    it('abort 恢复页面焦点时同步 focusout 不会给已释放通知重建计时器', async () => {
        const previous = document.createElement('button');document.body.appendChild(previous);
        Object.defineProperty(document, 'activeElement', {value: previous, configurable: true});
        const controller = new AbortController();
        const notice = showPageNotice('功能结束', 'error', {signal: controller.signal});await Promise.resolve();
        const close = notice.querySelector('.notice-close')!;
        noticeEvent(close, 'focusin', {relatedTarget: previous});
        Object.defineProperty(document, 'activeElement', {value: close, configurable: true});
        vi.spyOn(previous, 'focus').mockImplementation(() => {
            Object.defineProperty(document, 'activeElement', {value: previous, configurable: true});
            noticeEvent(close, 'focusout', {relatedTarget: previous});
        });
        controller.abort();expect(notice.isConnected).toBe(false);expect(vi.getTimerCount()).toBe(0);
    });
    it('已释放通知的迟到交互回调不能恢复计时器', () => {
        const add = vi.spyOn(window.HTMLElement.prototype, 'addEventListener');
        try {
            const controller = new AbortController();showPageNotice('旧通知', 'error', {signal: controller.signal});
            const leave = add.mock.calls.find(([type]) => type === 'mouseleave')![1] as EventListener;
            controller.abort();leave(new window.Event('mouseleave'));
            expect(vi.getTimerCount()).toBe(0);
        } finally {add.mockRestore();}
    });
    it('只处理通知内部 Escape，关闭时返回进入前页面焦点且不抢焦点', async () => {
        const original = document.createElement('button');document.body.appendChild(original);
        const previousFocus = vi.spyOn(original, 'focus');
        Object.defineProperty(document, 'activeElement', {value: original, configurable: true});
        const notice = showPageNotice('键盘可关闭', 'error');await Promise.resolve();
        expect(previousFocus).not.toHaveBeenCalled();
        const close = notice.querySelector('.notice-close')!;
        noticeEvent(close, 'focusin', {relatedTarget: original});
        Object.defineProperty(document, 'activeElement', {value: close, configurable: true});
        const ordinary = noticeEvent(close, 'keydown', {key: 'Enter'});expect(ordinary.defaultPrevented).toBe(false);
        const pageEscape = noticeEvent(original, 'keydown', {key: 'Escape'});expect(pageEscape.defaultPrevented).toBe(false);
        expect(notice.isConnected).toBe(true);
        const escape = noticeEvent(close, 'keydown', {key: 'Escape'});expect(escape.defaultPrevented).toBe(true);
        expect(previousFocus).toHaveBeenCalledWith({preventScroll: true});
        Object.defineProperty(document, 'activeElement', {value: original, configurable: true});
        await vi.advanceTimersByTimeAsync(180);expect(notice.isConnected).toBe(false);
    });
    it.each(['missing', 'disconnected', 'foreign-document', 'not-focusable'] as const)('关闭时不尝试返回无效的 %s 焦点目标', async reason => {
        const original = document.createElement('button');document.body.appendChild(original);
        const focus = vi.spyOn(original, 'focus');
        Object.defineProperty(document, 'activeElement', {value: reason === 'missing' ? null : original, configurable: true});
        const notice = showPageNotice('焦点来源失效', 'error');const close = notice.querySelector<HTMLButtonElement>('.notice-close')!;
        Object.defineProperty(document, 'activeElement', {value: close, configurable: true});
        if (reason === 'disconnected') original.remove();
        if (reason === 'foreign-document') Object.defineProperty(original, 'ownerDocument', {value: parseHTML('<html/>').document});
        if (reason === 'not-focusable') Object.defineProperty(original, 'focus', {value: undefined});
        close.click();expect(focus).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(180);expect(notice.isConnected).toBe(false);
    });
    it.each([
        [6000, 6000], [1, 1000], [60_000, 30_000], [0, 3500], [-1, 3500], [NaN, 3500], [Infinity, 3500], ['6000', 3500],
    ])('阅读时长 %s 有界且最终会关闭', async (duration, expected) => {
        const notice = showPageNotice('有界时长', 'error', {durationMs: duration as number});await Promise.resolve();
        await vi.advanceTimersByTimeAsync(Number(expected) - 1);expect(notice.classList.contains('is-leaving')).toBe(false);
        await vi.advanceTimersByTimeAsync(181);expect(notice.isConnected).toBe(false);expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['light', 'dark', 'auto', 'invalid'])('通知仅依扩展设置更新 %s 主题，同 key 重用也更新 host', theme => {
        config.theme = theme;const notice = showPageNotice('主题', 'error', {key: 'theme'});
        const host = document.getElementById('fluent-read-page-notice-host')!;
        expect(host.getAttribute('data-fr-theme')).toBe(theme === 'invalid' ? 'auto' : theme);
        config.theme = 'dark';expect(showPageNotice('主题更新', 'error', {key: 'theme'})).toBe(notice);
        expect(host.getAttribute('data-fr-theme')).toBe('dark');
    });
    it('已显示且文案相同的通知不重写角色、关闭标签或内容', async () => {
        const notice = showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'credential'});await Promise.resolve();
        const attribute = vi.spyOn(notice, 'setAttribute');const close = vi.spyOn(notice.querySelector('.notice-close')!, 'setAttribute');
        const action = notice.querySelector('.notice-action');
        for (let i = 0; i < 100; i++) expect(showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'credential'})).toBe(notice);
        expect(attribute).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(notice.querySelector('.notice-action')).toBe(action);
        expect(vi.getTimerCount()).toBe(1);
    });
    it('错误节流仍在一个时间窗显示首条，下一时间窗可以继续提示', () => {
        vi.setSystemTime(1000);sendErrorMessage('第一条');sendErrorMessage('窗口内另一条');
        const stack = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(stack.querySelectorAll('.page-notice')).toHaveLength(1);expect(stack.querySelector('.notice-detail')?.textContent).toContain('第一条');
        vi.setSystemTime(2000);sendErrorMessage('第二条');expect(stack.querySelectorAll('.page-notice')).toHaveLength(2);
    });
    it('脱离旧 signal 或已释放条目的迟到 abort 回调不会移除新反馈', () => {
        const old = new AbortController();const add = vi.spyOn(old.signal, 'addEventListener');
        const first = showPageNotice('旧提示', 'success', {key: 'copy', signal: old.signal});
        const callback = add.mock.calls[0][1] as EventListener;
        showPageNotice('新提示', 'success', {key: 'copy'});callback(new Event('abort'));
        expect(first.isConnected).toBe(true);
        const current = new AbortController();const addCurrent = vi.spyOn(current.signal, 'addEventListener');
        showPageNotice('当前提示', 'success', {key: 'copy', signal: current.signal});current.abort();
        (addCurrent.mock.calls[0][1] as EventListener)(new Event('abort'));expect(first.isConnected).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('已结束的功能不会挂载通知、宿主或计时器', () => {
        const controller = new AbortController();controller.abort();
        expect(showPageNotice('过期复制', 'success', {signal: controller.signal}).isConnected).toBe(false);
        expect(document.getElementById('fluent-read-page-notice-host')).toBeNull();expect(vi.getTimerCount()).toBe(0);
    });
    it('关闭动画期间再次反馈复用节点并撤销旧移除，不重复进入或过早关闭', async () => {
        const notice = showPageNotice('复制一', 'success', {key: 'copy'});await Promise.resolve();
        notice.querySelector<HTMLButtonElement>('.notice-close')!.click();
        notice.querySelector<HTMLButtonElement>('.notice-close')!.click();expect(vi.getTimerCount()).toBe(1);
        const revived = showPageNotice('复制二', 'success', {key: 'copy'});await Promise.resolve();
        expect(revived).toBe(notice);expect(notice.classList.contains('is-leaving')).toBe(false);
        await vi.advanceTimersByTimeAsync(180);expect(notice.isConnected).toBe(true);
        await vi.advanceTimersByTimeAsync(3500);expect(notice.isConnected).toBe(false);
        notice.querySelector<HTMLButtonElement>('.notice-close')!.click();expect(vi.getTimerCount()).toBe(0);
    });
    it('同组普通反馈和凭据提示互换时更新角色与 CTA，旧按钮失效', async () => {
        const notice = showPageNotice('已复制', 'success', {key: 'copy'});await Promise.resolve();
        showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'copy'});
        const action = notice.querySelector<HTMLButtonElement>('.notice-action')!;
        showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'copy'});
        expect(notice.querySelector('.notice-action')).toBe(action);expect(notice.getAttribute('role')).toBe('alert');
        const focus = vi.spyOn(notice.querySelector<HTMLButtonElement>('.notice-close')!, 'focus');
        Object.defineProperty(document, 'activeElement', {value: action, configurable: true});
        showPageNotice('已复制', 'success', {key: 'copy'});action.click();
        expect(notice.querySelector('.notice-action')).toBeNull();expect(sendMessage).not.toHaveBeenCalled();
        expect(focus).toHaveBeenCalledWith({preventScroll: true});expect(notice.getAttribute('role')).toBe('status');
    });
    it('队列满时保留用户正在操作的提示，移除未聚焦的最旧通知', () => {
        const first = showPageNotice('正在处理', 'error');const second = showPageNotice('未聚焦旧提示', 'error');
        const third = showPageNotice('第三条', 'success');
        Object.defineProperty(document, 'activeElement', {value: first.querySelector('.notice-close'), configurable: true});
        const fourth = showPageNotice('第四条', 'error');
        expect(first.isConnected).toBe(true);expect(second.isConnected).toBe(false);
        expect(third.isConnected).toBe(true);expect(fourth.isConnected).toBe(true);expect(vi.getTimerCount()).toBe(3);
    });
    it('宿主移走条目或内部堆栈后重建会取消旧帧与信号处理器，保留非通知节点', () => {
        const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0;
        window.requestAnimationFrame = fn => {frames.set(++nextFrame, fn);return nextFrame;};
        window.cancelAnimationFrame = id => {frames.delete(id);};
        const controller = new AbortController();const old = showPageNotice('旧条目', 'error', {signal: controller.signal});
        const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
        const unrelated = document.createElement('p');document.body.appendChild(unrelated);unrelated.appendChild(old);
        const current = showPageNotice('新条目', 'error');
        expect(old.isConnected).toBe(false);expect(unrelated.isConnected).toBe(true);expect(removeAbort).toHaveBeenCalledOnce();
        current.parentElement!.remove();showPageNotice('重建堆栈', 'error');expect(frames.size).toBe(1);expect(vi.getTimerCount()).toBe(1);
    });
    it('同文案不同类型或不同功能保留独立反馈，同 key 更新采用当前语言', async () => {
        registerAllUiLanguageBundles();const previous = config.uiLanguage;
        try {
            const first = showPageNotice('完成', 'success');const error = showPageNotice('完成', 'error');
            const keyed = showPageNotice('完成', 'success', {key: 'copy'});
            expect(first).not.toBe(error);expect(keyed).not.toBe(first);
            config.uiLanguage = 'en-US';showPageNotice('完成', 'success', {key: 'copy'});
            expect(keyed.querySelector('.notice-title')?.textContent).toBe('Done');
        } finally {config.uiLanguage = previous;}
    });
    it('同步发送错误也能隔离；脱离通知的凭据按钮不再发送', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            sendMessage.mockImplementationOnce(() => {throw new Error('invalid runtime');});
            const notice = showPageNotice('需要 API Key，请先配置', 'error');
            const action = notice.querySelector<HTMLButtonElement>('.notice-action')!;action.click();
            expect(error).toHaveBeenCalledWith('[FluentRead] 打开设置页失败', expect.any(Error));
            action.remove();action.click();expect(sendMessage).toHaveBeenCalledOnce();
        } finally {error.mockRestore();}
    });
    it.each([undefined, {}, {runtime: {}}, {runtime: {getURL: () => ''}}, {runtime: {getURL: () => 3}}])('不可用图标端口仍显示品牌与原文 %j', runtime => {
        Object.defineProperty(globalThis, 'browser', {value: runtime, configurable: true});
        const notice = showPageNotice('服务需要其他字段，当前尚未配置', 'error');
        expect(notice.querySelector('.notice-mark-fallback')?.textContent).toBe('流');
        expect(notice.querySelector('.notice-detail')?.textContent).toBe('服务需要其他字段，当前尚未配置');
        expect(notice.querySelector('.notice-action')).toBeNull();
    });
    it('连续复制只更新同一条通知，并保持一个待进入回调与一个关闭计时器', async () => {
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 0;
        const request = vi.fn((callback: FrameRequestCallback) => {frames.set(++nextFrame, callback); return nextFrame;});
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = (id) => {frames.delete(id);};
        const first = showPageNotice('已复制第一段', 'success', {key: 'paragraph-copy'});
        for (let index = 0; index < 500; index++) showPageNotice(`已复制第 ${index} 段`, 'success', {key: 'paragraph-copy'});
        const stack = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(stack.querySelectorAll('.page-notice')).toHaveLength(1);
        expect(stack.querySelector('.page-notice') === first).toBe(true);
        expect(first.textContent).toContain('已复制第 499 段');
        expect(request).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        expect(first.getAttribute('role')).toBe('status');
    });

    it('独立通知突发时最多保留三条最新反馈，替换即清理旧回调和定时器', () => {
        const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0;
        window.requestAnimationFrame = callback => {frames.set(++nextFrame, callback); return nextFrame;};
        window.cancelAnimationFrame = id => {frames.delete(id);};
        for (let index = 0; index < 500; index++) showPageNotice(`错误 ${index}`, 'error');
        const stack = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect([...stack.querySelectorAll('.notice-detail')].map(node => node.textContent)).toEqual(['错误 497', '错误 498', '错误 499']);
        expect(frames.size).toBe(3);expect(vi.getTimerCount()).toBe(3);
    });

    it('相同文案和类型自动复用，重置停留时长而非过早移除', async () => {
        const first = showPageNotice('同一错误', 'error');
        await vi.advanceTimersByTimeAsync(3000);
        const second = showPageNotice('同一错误', 'error');
        expect(second === first).toBe(true);
        await vi.advanceTimersByTimeAsync(600);expect(first.isConnected).toBe(true);
        await vi.advanceTimersByTimeAsync(3080);expect(first.isConnected).toBe(false);
    });

    it('复制功能停止立即清理它的通知，保留独立错误；旧 signal 不清理新实例', () => {
        const old = new AbortController(), current = new AbortController();
        const first = showPageNotice('已复制', 'success', {key: 'paragraph-copy', signal: old.signal});
        const next = showPageNotice('新实例已复制', 'success', {key: 'paragraph-copy', signal: current.signal});
        const error = showPageNotice('独立错误', 'error');
        old.abort();expect(next === first).toBe(true);expect(next.isConnected).toBe(true);
        current.abort();expect(next.isConnected).toBe(false);expect(error.isConnected).toBe(true);
    });

    it('宿主已拆掉通知 host 后重建时，不保留旧计时器或处理器', () => {
        const old = showPageNotice('旧错误', 'error');
        document.getElementById('fluent-read-page-notice-host')!.remove();
        showPageNotice('新错误', 'error');
        expect(vi.getTimerCount()).toBe(1);
        expect(old.isConnected).toBe(false);
    });

    beforeEach(() => {
        vi.useFakeTimers();
        config.theme = originalTheme;
        sendMessage.mockClear();
        const {document, window} = parseHTML(`
            <html>
                <body>
                    <p>Translation target</p>
                    <div style="height: 6000px">Long page spacer</div>
                </body>
            </html>
        `);
        Object.defineProperty(globalThis, 'document', {value: document, configurable: true});
        Object.defineProperty(globalThis, 'window', {value: window, configurable: true});
        // linkedom 的 window 代理共享全局属性，逐例重置可控 RAF 端口。
        window.requestAnimationFrame = undefined as unknown as typeof window.requestAnimationFrame;
        window.cancelAnimationFrame = vi.fn();
        Object.defineProperty(globalThis, 'browser', {
            value: {
                runtime: {
                    getURL: (path: string) => `chrome-extension://fixture${path}`,
                    sendMessage,
                },
            },
            configurable: true,
        });
    });

    afterEach(() => {
        document.getElementById('fluent-read-page-notice-host')?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.notice-close').forEach(close => close.click());
        vi.runAllTimers();
        vi.useRealTimers();
        config.theme = originalTheme;
        Object.defineProperty(globalThis, 'document', {value: originalDocument, configurable: true});
        Object.defineProperty(globalThis, 'window', {value: originalWindow, configurable: true});
        Object.defineProperty(globalThis, 'browser', {value: originalBrowser, configurable: true});
    });

    it('keeps error details fixed to the viewport on a long page', async () => {
        const notice = showPageNotice('Failed to fetch', 'error');
        await Promise.resolve();

        const host = document.getElementById('fluent-read-page-notice-host')!;
        expect(host.parentElement).toBe(document.documentElement);
        expect(host.hasAttribute('data-fluent-read-ui')).toBe(true);
        expect(host.getAttribute('translate')).toBe('no');
        expect(host.style.getPropertyValue('position')).toBe('fixed');
        expect(host.style.getPropertyValue('z-index')).toBe('2147483647');
        expect(host.style.getPropertyValue('pointer-events')).toBe('none');

        const shadow = host.shadowRoot!;
        expect(shadow.querySelector('.notice-stack')).not.toBeNull();
        expect(noticeCss).toMatch(/\.notice-stack\s*\{[^}]*position:\s*fixed/s);
        expect(notice.getAttribute('role')).toBe('alert');
        expect(notice.textContent).toContain('Failed to fetch');
        expect(notice.classList.contains('is-visible')).toBe(true);
    });

    it('扩展上下文失效时仍显示错误详情，并使用本地品牌占位', async () => {
        Object.defineProperty(globalThis, 'browser', {
            value: {
                runtime: {
                    getURL: () => {
                        throw new Error('Extension context invalidated.');
                    },
                    sendMessage,
                },
            },
            configurable: true,
        });

        expect(() => showPageNotice('扩展已更新，请刷新当前页面后重试。', 'error')).not.toThrow();
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain('请刷新当前页面');
        expect(shadow.querySelector('.notice-mark-fallback')?.textContent).toBe('流');
    });

    it('keeps credential guidance interactive inside the isolated notice', async () => {
        showPageNotice('DeepSeek 需要 API Key（访问令牌），当前尚未配置', 'error');
        await Promise.resolve();

        const host = document.getElementById('fluent-read-page-notice-host')!;
        const shadow = host.shadowRoot!;
        const action = shadow.querySelector<HTMLButtonElement>('.notice-action')!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain('为 DeepSeek 填写 API Key');

        action.click();
        expect(sendMessage).toHaveBeenCalledWith({type: 'openOptionsPage'});
    });

    it('隔离设置页打开失败，不产生未处理拒绝', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        sendMessage.mockRejectedValueOnce(new Error('runtime disconnected'));
        showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error');
        await Promise.resolve();

        const action = document.getElementById('fluent-read-page-notice-host')!
            .shadowRoot!.querySelector<HTMLButtonElement>('.notice-action')!;
        action.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleError).toHaveBeenCalledWith('[FluentRead] 打开设置页失败', expect.any(Error));
        consoleError.mockRestore();
    });

    it.each([
        ['有道翻译 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。', 'App Key 和 App Secret'],
        ['腾讯翻译 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。', 'SecretId 和 SecretKey'],
    ])('offers settings for every supported missing credential type', async (message, credentialLabel) => {
        showPageNotice(message, 'error');
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain(credentialLabel);
        const action = shadow.querySelector<HTMLButtonElement>('.notice-action')!;
        action.click();
        expect(sendMessage).toHaveBeenCalledWith({type: 'openOptionsPage'});
    });

    it.each([
        ['ja-JP' as const, 'あと一歩です：DeepSeek の API キー（アクセストークン） を入力すると翻訳を始められます。', '画像翻訳に失敗しました：オフスクリーンドキュメントの準備がタイムアウトしました'],
        ['fr-FR' as const, 'Plus qu’une étape : ajoutez App Key et App Secret pour le service de traduction actuel afin de commencer à traduire.', 'Échec de la traduction de l’image : La préparation du document hors écran a expiré'],
    ])('localizes missing credential guidance and runtime feedback in %s', async (language, detail, imageFailure) => {
        registerAllUiLanguageBundles();
        const previousLanguage = config.uiLanguage;
        config.uiLanguage = language;
        try {
            showPageNotice(language === 'ja-JP'
                ? 'DeepSeek 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。'
                : '当前翻译服务还没有配置 App Key 和 App Secret', 'error');
            showPageNotice('图片翻译失败：Offscreen 文档准备超时', 'error');
            await Promise.resolve();

            const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
            const details = [...shadow.querySelectorAll('.notice-detail')].map((node) => node.textContent);
            expect(details[0]).toBe(detail);
            expect(details[1]).toBe(imageFailure);
            expect(shadow.querySelector<HTMLImageElement>('img.notice-mark')?.alt).toBe('FluentRead');
            expect(shadow.querySelector('img.notice-mark')?.getAttribute('aria-hidden')).toBe('true');
        } finally {
            config.uiLanguage = previousLanguage;
        }
    });

    it('keeps invalid credential diagnostics instead of treating them as missing setup', async () => {
        const message = '当前翻译服务的 API Key 无效、已过期或没有模型访问权限（HTTP 401）。';
        showPageNotice(message, 'error');
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toBe(message);
        expect(shadow.querySelector('.notice-action')).toBeNull();
    });

    it('keeps the settings action for a legacy generic missing-key error', async () => {
        showPageNotice('当前翻译服务还没有配置 API Key，请前往设置页面填写后再试。', 'error');
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain('API Key');
        expect(shadow.querySelector('.notice-action')).not.toBeNull();
    });

    it('removes the isolated host after the last notice is closed', async () => {
        showPageNotice('Provider unavailable', 'error');
        await Promise.resolve();

        const host = document.getElementById('fluent-read-page-notice-host')!;
        host.shadowRoot!.querySelector<HTMLButtonElement>('.notice-close')!.click();
        await vi.advanceTimersByTimeAsync(180);

        expect(document.getElementById('fluent-read-page-notice-host')).toBeNull();
    });
});
