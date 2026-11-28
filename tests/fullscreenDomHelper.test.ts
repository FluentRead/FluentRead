/**
 * @file tests/fullscreenDomHelper.test.ts
 * 文件职责：验证跨浏览器全屏/画中画平台工具与开放 Shadow DOM 深度查询工具的全部行为与边界。
 * 主要内容：覆盖标准与 webkit 全屏元素读取、双事件监听与销毁、画中画判定、多层开放 ShadowRoot 遍历、深度上限、自有节点过滤与结果去重。
 * 模块边界：仅测试纯 DOM 辅助模块，不挂载扩展运行时或翻译服务。
 */
import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    getFullscreenElement,
    isElementInPictureInPicture,
    onFullscreenChange,
} from '@/src/platform/dom/fullscreen';
import {containsDeep, hasSelectorDeep, querySelectorAllDeep} from '@/src/shared/dom/shadowQuery';

describe('跨浏览器全屏与画中画辅助函数', () => {
    it('按标准优先并兼容 webkitFullscreenElement，缺省返回 null', () => {
        const {document} = parseHTML('<html><body><div id="std"></div><div id="wk"></div></body></html>');
        const std = document.getElementById('std')!;
        const wk = document.getElementById('wk')!;

        expect(getFullscreenElement(document)).toBeNull();

        Object.defineProperty(document, 'webkitFullscreenElement', {configurable: true, value: wk});
        expect(getFullscreenElement(document)).toBe(wk);

        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: std});
        expect(getFullscreenElement(document)).toBe(std);

        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null});
        expect(getFullscreenElement(document)).toBe(wk);

        Object.defineProperty(document, 'webkitFullscreenElement', {configurable: true, value: null});
        expect(getFullscreenElement(document)).toBeNull();
    });

    it('同时监听标准与 webkitfullscreenchange 并在销毁后完整移除', () => {
        const {document, window} = parseHTML('<html><body></body></html>');
        const listener = vi.fn();
        const dispose = onFullscreenChange(document, listener, true);

        document.dispatchEvent(new window.Event('fullscreenchange'));
        document.dispatchEvent(new window.Event('webkitfullscreenchange'));
        expect(listener).toHaveBeenCalledTimes(2);

        dispose();
        document.dispatchEvent(new window.Event('fullscreenchange'));
        document.dispatchEvent(new window.Event('webkitfullscreenchange'));
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('安全判定 pictureInPictureElement，空媒体和缺失 API 返回 false', () => {
        const {document} = parseHTML('<html><body><video id="v1"></video><video id="v2"></video></body></html>');
        const v1 = document.getElementById('v1') as unknown as HTMLMediaElement;
        const v2 = document.getElementById('v2') as unknown as HTMLMediaElement;

        expect(isElementInPictureInPicture(document, null)).toBe(false);
        expect(isElementInPictureInPicture(document, v1)).toBe(false);

        Object.defineProperty(document, 'pictureInPictureElement', {configurable: true, value: null});
        expect(isElementInPictureInPicture(document, null)).toBe(false);
        expect(isElementInPictureInPicture(document, v1)).toBe(false);

        Object.defineProperty(document, 'pictureInPictureElement', {configurable: true, value: v1});
        expect(isElementInPictureInPicture(document, v1)).toBe(true);
        expect(isElementInPictureInPicture(document, v2)).toBe(false);

        // Safari webkitPresentationMode 原生画中画兼容
        Object.defineProperty(document, 'pictureInPictureElement', {configurable: true, value: null});
        Object.defineProperty(v2, 'webkitPresentationMode', {configurable: true, value: 'inline'});
        expect(isElementInPictureInPicture(document, v2)).toBe(false);
        Object.defineProperty(v2, 'webkitPresentationMode', {configurable: true, value: 'picture-in-picture'});
        expect(isElementInPictureInPicture(document, v2)).toBe(true);
    });
});

describe('querySelectorAllDeep、hasSelectorDeep 与 containsDeep 开放 Shadow DOM 深度工具', () => {
    it('收集轻 DOM 与多层开放 Shadow DOM 节点，尊重 maxDepth、直接查询 shadow host 并跳过所有自有节点', () => {
        const {document} = parseHTML(`
            <html><body>
                <video id="light"></video>
                <div id="owned-light" data-fluent-read-owned="true"><video id="owned-light-video"></video></div>
                <div id="owned-ui" data-fluent-read-ui="video-subtitle"><video id="owned-ui-video"></video></div>
                <div id="owned-class" class="fluent-read-video-ui"><video id="owned-class-video"></video></div>
                <div id="owned-host" data-fluent-read-owned="true"></div>
                <div id="outer-host"></div>
            </body></html>
        `);
        const ownedHost = document.getElementById('owned-host')!;
        const ownedShadow = ownedHost.attachShadow({mode: 'open'});
        const ownedShadowVideo = document.createElement('video');
        ownedShadowVideo.id = 'owned-shadow-video';
        ownedShadow.appendChild(ownedShadowVideo);

        const outerHost = document.getElementById('outer-host')!;
        const shadow1 = outerHost.attachShadow({mode: 'open'});
        const v1 = document.createElement('video');
        v1.id = 'shadow-1';
        const innerHost = document.createElement('div');
        shadow1.append(v1, innerHost);

        const shadow2 = innerHost.attachShadow({mode: 'open'});
        const v2 = document.createElement('video');
        v2.id = 'shadow-2';
        shadow2.appendChild(v2);

        const all = querySelectorAllDeep<HTMLVideoElement>(document, 'video');
        expect(all.map(node => node.id)).toEqual(['light', 'shadow-1', 'shadow-2']);

        const depth1 = querySelectorAllDeep<HTMLVideoElement>(document, 'video', 1);
        expect(depth1.map(node => node.id)).toEqual(['light', 'shadow-1']);

        const depth0 = querySelectorAllDeep<HTMLVideoElement>(document, 'video', 0);
        expect(depth0.map(node => node.id)).toEqual(['light']);

        // 直接从 shadow host 元素启动查询（覆盖 root.shadowRoot）
        expect(querySelectorAllDeep<HTMLVideoElement>(outerHost, 'video').map(node => node.id)).toEqual(['shadow-1', 'shadow-2']);
        expect(hasSelectorDeep(outerHost, 'video')).toBe(true);
        expect(hasSelectorDeep(outerHost, 'video', 0)).toBe(false);

        // 自有根节点立即短路返回空 / false
        for (const id of ['owned-light', 'owned-ui', 'owned-class', 'owned-host']) {
            const ownedRoot = document.getElementById(id)!;
            expect(querySelectorAllDeep(ownedRoot, 'video')).toEqual([]);
            expect(hasSelectorDeep(ownedRoot, 'video')).toBe(false);
        }
    });

    it('hasSelectorDeep 优先 O(1) 轻 DOM 短路，跳过自有匹配后回退扫描并穿透 Shadow DOM', () => {
        const {document} = parseHTML(`
            <html><body>
                <section id="fast"><video id="real"></video></section>
                <section id="mixed">
                    <video class="fluent-read-video-ui"></video>
                    <video id="second-real"></video>
                </section>
                <section id="owned-only">
                    <video data-fluent-read-ui="1"></video>
                    <div id="shadow-holder"></div>
                </section>
            </body></html>
        `);
        const fast = document.getElementById('fast')!;
        const walkerSpy = vi.spyOn(document, 'createTreeWalker');
        const allSpy = vi.spyOn(fast, 'querySelectorAll');
        expect(hasSelectorDeep(fast, 'video')).toBe(true);
        expect(walkerSpy).not.toHaveBeenCalled();
        expect(allSpy).not.toHaveBeenCalled();

        const mixed = document.getElementById('mixed')!;
        expect(hasSelectorDeep(mixed, 'video')).toBe(true);
        expect(walkerSpy).not.toHaveBeenCalled();

        const ownedOnly = document.getElementById('owned-only')!;
        expect(hasSelectorDeep(ownedOnly, 'video')).toBe(false);
        const holder = document.getElementById('shadow-holder')!;
        const sr = holder.attachShadow({mode: 'open'});
        sr.appendChild(document.createElement('video'));
        expect(hasSelectorDeep(ownedOnly, 'video')).toBe(true);
        expect(hasSelectorDeep(ownedOnly, 'audio')).toBe(false);
    });

    it('TreeWalker 过滤器按分支级 FILTER_REJECT 剪枝自有子树，缺失 createTreeWalker 时安全回退', () => {
        const {document} = parseHTML(`
            <html><body>
                <div id="owned" data-fluent-read-owned="true"><div id="owned-child"></div></div>
                <div id="plain"><div id="host"></div></div>
            </body></html>
        `);
        const host = document.getElementById('host')!;
        const sr = host.attachShadow({mode: 'open'});
        const shadowVideo = document.createElement('video');
        shadowVideo.id = 'tw-shadow-video';
        sr.appendChild(shadowVideo);

        // 模拟遵循标准 W3C NodeFilter 返回值（FILTER_ACCEPT=1, FILTER_REJECT=2, FILTER_SKIP=3）的 createTreeWalker
        const decisions: Array<[string, number]> = [];
        const origCreateTreeWalker = document.createTreeWalker.bind(document);
        vi.spyOn(document, 'createTreeWalker').mockImplementation((root: Node, whatToShow?: number, filter?: NodeFilter | null) => {
            const inner = origCreateTreeWalker(root, whatToShow);
            const acceptNode = typeof filter === 'function' ? filter : filter?.acceptNode;
            const visited: Node[] = [];
            const walk = (parent: Node) => {
                for (const child of Array.from(parent.childNodes)) {
                    if (child.nodeType !== 1) continue;
                    const decision = acceptNode ? acceptNode(child) : 1;
                    decisions.push([(child as Element).id || child.nodeName, decision]);
                    if (decision === 2) continue; // FILTER_REJECT: 剪枝整棵子树
                    if (decision === 1) visited.push(child);
                    walk(child);
                }
            };
            walk(root);
            let index = 0;
            return {
                ...inner,
                nextNode: () => visited[index++] ?? null,
            } as unknown as TreeWalker;
        });

        expect(querySelectorAllDeep<HTMLVideoElement>(document.body, 'video').map(n => n.id)).toEqual(['tw-shadow-video']);
        expect(decisions).toEqual([
            ['owned', 2],
            ['plain', 3],
            ['host', 1],
            ['tw-shadow-video', 3],
        ]);
        expect(hasSelectorDeep(document.body, 'video')).toBe(true);

        // 缺失 createTreeWalker 的最小 ParentNode 回退路径（含去重、命中短路与未命中）
        const dupVideo = document.createElement('video');
        const fallbackHost = {
            shadowRoot: sr,
            closest: () => null,
        } as unknown as Element;
        const fallbackRoot = {
            querySelector: () => null,
            querySelectorAll: (selector: string) => (selector === 'video' ? [dupVideo, dupVideo] : [fallbackHost]),
        } as unknown as ParentNode;
        expect(querySelectorAllDeep(fallbackRoot, 'video')).toEqual([dupVideo, shadowVideo]);
        expect(hasSelectorDeep(fallbackRoot, 'video')).toBe(true);
        expect(hasSelectorDeep(fallbackRoot, 'audio')).toBe(false);
    });

    it('containsDeep 穿透多层开放 Shadow DOM 判定包含关系并安全处理空/无关节点', () => {
        const {document} = parseHTML('<div id="outer"><div id="host"></div></div><div id="other"></div>');
        const outer = document.getElementById('outer')!;
        const host = document.getElementById('host')!;
        const other = document.getElementById('other')!;
        const shadow1 = host.attachShadow({mode: 'open'});
        const innerHost = document.createElement('div');
        shadow1.appendChild(innerHost);
        const shadow2 = innerHost.attachShadow({mode: 'open'});
        const deepVideo = document.createElement('video');
        shadow2.appendChild(deepVideo);
        const detached = document.createElement('video');

        expect(containsDeep(outer, null)).toBe(false);
        expect(containsDeep(outer, outer)).toBe(true);
        expect(containsDeep(outer, host)).toBe(true);
        expect(containsDeep(outer, deepVideo)).toBe(true);
        expect(containsDeep(host, deepVideo)).toBe(true);
        expect(containsDeep(other, deepVideo)).toBe(false);
        expect(containsDeep(outer, detached)).toBe(false);
    });
});
