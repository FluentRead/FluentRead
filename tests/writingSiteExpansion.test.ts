import './helpers/vueDomFixture';
/**
 * @file tests/writingSiteExpansion.test.ts
 * 文件职责：验证写作助手一等支持网站扩展、通用网页快捷键模式、富文本框架复制回退、双向快捷键冲突校验与入口设置真实组件行为。
 * 主要内容：覆盖 Outlook、X、Reddit、LinkedIn、Slack、Discord、Notion 七个新增平台的编辑器发现、锚点定位和上下文采集；覆盖通用网页编辑区识别、周边参考采集、Slate/ProseMirror/Lexical/Draft.js 复制回退与按需快捷键挂载生命周期；执行 WritingEntrySettings 真实 Vue 组件的焦点循环、范围选择与状态反馈。
 * 模块边界：所有 DOM 与键盘事件均在确定性 Linkedom 环境中运行，不发起在线请求或真实浏览器操作。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createRenderer, effectScope, h, markRaw, nextTick, ref, shallowReactive, type App} from 'vue';

const shortcutMocks = vi.hoisted(() => ({
    config: {} as any,
    mountWriting: vi.fn(async () => {}),
    unmountWriting: vi.fn(),
    writingMounted: false,
}));

vi.mock('@/src/services/config/store', () => ({
    config: shortcutMocks.config,
}));
vi.mock('@/src/ui/i18n', () => ({
    useUiI18n: () => ({
        t: (key: string, params?: Record<string, string>) => params ? `${key}:${JSON.stringify(params)}` : key,
        translateLegacy: (text: string) => text,
    }),
}));
vi.mock('@/src/features/writing-assistant/ui/WritingPopover.vue', () => ({
    default: {
        props: ['active', 'anchor', 'width'],
        setup(_props: unknown, {slots}: any) {
            return () => h('div', {'data-popover-fixture': ''}, slots.default?.());
        },
    },
}));

import {Config, normalizeConfig} from '@/src/core/config/model';
import {findClickSelectionHotkeyConflict} from '@/src/core/config/clickSelection';
import {
    applyWritingDraft,
    captureEditor,
    collectReplyContext,
    deepActiveElement,
    findReplyActionAnchor,
    findReplyEditors,
    hasComplexRichEditorStructure,
    hasManagedRichEditor,
    isPlainTextWritingSite,
    isWritingEditor,
    resolveEditableTarget,
    resolveInitialWritingIntent,
    resolveWritingSite,
    writingSite,
} from '@/src/features/writing-assistant/editors';
import {getWritingSiteProfile} from '@/src/features/writing-assistant/siteProfiles';
import {clearPendingWritingOpenTarget, mountWritingShortcut, registerWritingOpenHandler} from '@/src/features/writing-assistant/shortcutRuntime';
import {useTranslationShortcutSettings} from '@/src/features/settings/ui/useTranslationShortcutSettings';
import WritingEntrySettings from '@/src/features/writing-assistant/ui/WritingEntrySettings.vue';

function page(html: string) {
    const parsed = parseHTML(`<html><body>${html}</body></html>`);
    const doc = parsed.document;
    doc.querySelectorAll<HTMLElement>('*').forEach(element => {
        element.getClientRects = () => [{}] as never;
    });
    return {doc, win: parsed.window};
}

function keyEvent(win: any, overrides: Record<string, unknown> = {}): KeyboardEvent {
    const {isTrusted = true, ...rest} = overrides;
    const event = new win.Event('keydown', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'isTrusted', {value: isTrusted});
    Object.assign(event, {
        repeat: false,
        altKey: true,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        key: 'W',
        code: 'KeyW',
        ...rest,
    });
    return event as KeyboardEvent;
}

describe('First-class writing site expansion (7 new platforms)', () => {
    it('maps all supported hosts and resolves plainTextOutput and generic fallback accurately', () => {
        const cases: Array<[string, ReturnType<typeof writingSite>, boolean]> = [
            ['https://mail.google.com/mail/u/0/', 'gmail', true],
            ['https://github.com/o/r/issues/1', 'github', false],
            ['https://outlook.live.com/mail/0/inbox', 'outlook', true],
            ['https://outlook.office.com/mail/', 'outlook', true],
            ['https://outlook.office365.com/mail/', 'outlook', true],
            ['https://x.com/user/status/1', 'x', true],
            ['https://twitter.com/home', 'x', true],
            ['https://reddit.com/r/ts', 'reddit', false],
            ['https://www.reddit.com/r/ts/comments/1', 'reddit', false],
            ['https://old.reddit.com/r/ts', 'reddit', false],
            ['https://sh.reddit.com/r/ts', 'reddit', false],
            ['https://linkedin.com/feed/', 'linkedin', true],
            ['https://www.linkedin.com/messaging/', 'linkedin', true],
            ['https://app.slack.com/client/T1/C1', 'slack', true],
            ['https://discord.com/channels/1/2', 'discord', false],
            ['https://ptb.discord.com/channels/1/2', 'discord', false],
            ['https://canary.discord.com/channels/1/2', 'discord', false],
            ['https://notion.so/page-1', 'notion', false],
            ['https://www.notion.so/page-1', 'notion', false],
        ];
        for (const [url, expected, plain] of cases) {
            expect(writingSite(url), url).toBe(expected);
            expect(resolveWritingSite(url), url).toBe(expected);
            expect(getWritingSiteProfile(expected)?.site).toBe(expected);
            expect(isPlainTextWritingSite(expected), url).toBe(plain);
        }
        expect(writingSite('https://example.com/post')).toBeNull();
        expect(writingSite('ftp://x.com/foo')).toBeNull();
        expect(writingSite('ws://github.com/a/b')).toBeNull();
        expect(writingSite('http://outlook.office.com/mail/')).toBeNull();
        expect(resolveWritingSite('https://example.com/post')).toBe('generic');
        expect(resolveWritingSite('https://github.com/settings/profile')).toBe('generic');
        expect(resolveWritingSite('https://mail.google.com/settings')).toBe('generic');
        expect(resolveWritingSite('ftp://x.com/foo')).toBeNull();
        expect(resolveWritingSite('chrome://settings')).toBeNull();
        expect(getWritingSiteProfile('generic')).toBeNull();
        expect(getWritingSiteProfile(null)).toBeNull();
        expect(isPlainTextWritingSite('generic')).toBe(true);
        expect(isPlainTextWritingSite(undefined)).toBe(true);
    });

    it('supports Outlook compose/reply editor, subject, thread body, and send button anchor', () => {
        const {doc} = page(`<main role="main">
            <div data-testid="SubjectLine">Q4 Launch Plan</div>
            <div aria-label="Message body">Can we confirm the release window?</div>
            <div data-app-section="MailCompose">
                <input aria-label="Add a subject" value="Re: Q4 Launch Plan">
                <div role="textbox" contenteditable="true">Draft reply</div>
                <button data-testid="ComposeSendButton" aria-label="Send">Send</button>
            </div>
        </main>`);
        const editors = findReplyEditors(doc, 'outlook');
        expect(editors).toHaveLength(1);
        expect(findReplyActionAnchor(editors[0], 'outlook')?.textContent).toBe('Send');
        const context = collectReplyContext(doc, 'outlook', editors[0]);
        expect(context).toContain('邮件主题：Q4 Launch Plan');
        expect(context).toContain('当前邮件：Can we confirm the release window?');
        expect(resolveInitialWritingIntent('outlook', 'https://outlook.office.com/mail/', '', context)).toBe('reply');
        expect(resolveInitialWritingIntent('outlook', 'https://outlook.office.com/mail/', '', '邮件主题：New mail')).toBe('draft');
        // Standalone new-compose dialog reads the editable Subject input directly.
        const compose = page('<div role="dialog"><input aria-label="Add a subject" value="New Proposal"><div role="textbox" contenteditable="true"></div><button aria-label="Send">Send</button></div>').doc;
        expect(collectReplyContext(compose, 'outlook', findReplyEditors(compose, 'outlook')[0])).toBe('邮件主题：New Proposal');
    });

    it('supports X / Twitter compose box, parent tweet context with author, and tweetButton anchor', () => {
        const {doc} = page(`<main><div data-testid="primaryColumn">
            <article><div data-testid="User-Name">Alice</div><div data-testid="tweetText">Shipping v2 today!</div></article>
            <div data-testid="inline_reply_offscreen">
                <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
                <button data-testid="tweetButtonInline">Reply</button>
            </div>
        </div></main>`);
        const editors = findReplyEditors(doc, 'x');
        expect(editors).toHaveLength(1);
        expect(findReplyActionAnchor(editors[0], 'x')?.textContent).toBe('Reply');
        const context = collectReplyContext(doc, 'x', editors[0]);
        expect(context).toContain('当前推文：回复作者：Alice\nShipping v2 today!');
        expect(resolveInitialWritingIntent('x', 'https://x.com/alice/status/1', '', context)).toBe('reply');
        expect(resolveInitialWritingIntent('x', 'https://x.com/home', '', '')).toBe('draft');
    });

    it('supports Reddit shreddit-composer and old reddit textareas with post title and parent comment', () => {
        const {doc} = page(`<main>
            <shreddit-post><h1 slot="title">Best TypeScript tips</h1></shreddit-post>
            <shreddit-comment>
                <a slot="authorName">dev_user</a>
                <div slot="comment">Use strict mode everywhere.</div>
                <shreddit-composer>
                    <div contenteditable="true" role="textbox"></div>
                    <button slot="submit-button">Comment</button>
                </shreddit-composer>
            </shreddit-comment>
            <form class="usertext-edit"><textarea name="text"></textarea><button class="save">save</button></form>
        </main>`);
        const editors = findReplyEditors(doc, 'reddit');
        expect(editors).toHaveLength(2);
        expect(findReplyActionAnchor(editors[0], 'reddit')?.textContent).toBe('Comment');
        expect(findReplyActionAnchor(editors[1], 'reddit')?.textContent).toBe('save');
        const context = collectReplyContext(doc, 'reddit', editors[0]);
        expect(context).toContain('帖子标题：Best TypeScript tips');
        expect(context).toContain('回复作者：dev_user');
        expect(context).toContain('Use strict mode everywhere.');
    });

    it('supports LinkedIn Quill and role=textbox editors with post/message context', () => {
        const {doc} = page(`<main><div class="msg-convo-wrapper">
            <h2 class="msg-overlay-bubble-header__title">Partnership chat</h2>
            <div class="msg-s-message-group">
                <span class="msg-s-message-group__name">Bob</span>
                <p class="msg-s-event-listitem__body">Would love to connect next Tuesday.</p>
            </div>
            <form class="msg-form">
                <div class="ql-editor" contenteditable="true"></div>
                <button class="msg-form__send-button" type="submit">Send</button>
            </form>
        </div></main>`);
        const editors = findReplyEditors(doc, 'linkedin');
        expect(editors).toHaveLength(1);
        expect(findReplyActionAnchor(editors[0], 'linkedin')?.textContent).toBe('Send');
        const context = collectReplyContext(doc, 'linkedin', editors[0]);
        expect(context).toContain('会话主题：Partnership chat');
        expect(context).toContain('回复作者：Bob\nWould love to connect next Tuesday.');
    });

    it('supports Slack message composer, send button, and visible channel/thread context', () => {
        const {doc} = page(`<main><div class="p-workspace__secondary_view">
            <div data-qa="channel_name">#frontend-team</div>
            <div data-qa="virtual-list-item">
                <button data-qa="message_sender_name">Carol</button>
                <div data-qa="message-text">Please review PR #42 before standup.</div>
            </div>
            <div data-qa="message_composer">
                <div data-qa="message_input"><div class="ql-editor" contenteditable="true"></div></div>
                <button data-qa="texty_send_button">Send</button>
            </div>
        </div></main>`);
        const editors = findReplyEditors(doc, 'slack');
        expect(editors).toHaveLength(1);
        expect(findReplyActionAnchor(editors[0], 'slack')?.textContent).toBe('Send');
        const context = collectReplyContext(doc, 'slack', editors[0]);
        expect(context).toContain('频道主题：#frontend-team');
        expect(context).toContain('Please review PR #42 before standup.');
    });

    it('supports Discord Slate message composer with recent messages and safe copy fallback', () => {
        const {doc} = page(`<main>
            <h1>#general</h1>
            <li id="chat-messages-1"><span class="username_abc">Dan</span><div id="message-content-1">Anyone free to pair?</div></li>
            <form>
                <div role="textbox" data-slate-editor="true" contenteditable="true">Initial</div>
                <button type="submit">Send</button>
            </form>
        </main>`);
        const editors = findReplyEditors(doc, 'discord');
        expect(editors).toHaveLength(1);
        expect(findReplyActionAnchor(editors[0], 'discord')?.textContent).toBe('Send');
        const context = collectReplyContext(doc, 'discord', editors[0]);
        expect(context).toContain('频道主题：#general');
        expect(context).toContain('回复作者：Dan\nAnyone free to pair?');
        expect(hasManagedRichEditor(editors[0])).toBe(true);
        expect(hasComplexRichEditorStructure(editors[0])).toBe(true);
        const snap = captureEditor(editors[0], 'https://discord.com/channels/1/2');
        expect(applyWritingDraft(snap, 'Sure!', snap.url)).toContain('页面框架托管');
    });

    it('supports Notion comment/page editable regions and surrounding block context', () => {
        const {doc} = page(`<main>
            <div class="notion-page-block"><h1>Architecture RFC</h1></div>
            <div class="notion-page-discussion">
                <div data-content-editable-leaf="true">Should we split the storage layer?</div>
                <div contenteditable="true" role="textbox"></div>
                <div role="button" aria-label="Send comment">Send</div>
            </div>
        </main>`);
        const editors = findReplyEditors(doc, 'notion');
        expect(editors).toHaveLength(1);
        expect(findReplyActionAnchor(editors[0], 'notion')?.textContent).toBe('Send');
        const context = collectReplyContext(doc, 'notion', editors[0]);
        expect(context).toContain('Should we split the storage layer?');
        expect(resolveInitialWritingIntent('notion', 'https://www.notion.so/rfc', '', context)).toBe('draft');
    });
});

describe('Universal generic editor mode & rich framework copy fallback', () => {
    it('accepts standard text controls and contenteditable in generic mode while excluding password/hidden/UI nodes', () => {
        const {doc} = page(`
            <textarea id="ta"></textarea>
            <input id="text" type="text">
            <input id="plain">
            <input id="pw" type="password">
            <div id="ce" contenteditable="true">
                <p id="child">Inner text</p>
                <span contenteditable="false"><em id="island">Read-only chip</em></span>
                <input id="nested-pw" type="password">
                <textarea id="nested-disabled" disabled></textarea>
                <select id="nested-select"><option>A</option></select>
                <button id="nested-btn" type="button">Act</button>
                <span id="nested-role-btn" role="button">Role act</span>
            </div>
            <div id="bare-ce" contenteditable=""></div>
            <div id="aria-disabled-ce" contenteditable="true" aria-disabled="true"></div>
            <div id="aria-readonly-ce" contenteditable="true" aria-readonly="true"></div>
            <div id="pt" contenteditable="plaintext-only"></div>
            <div id="div">Not editable</div>
            <div data-fluent-read-ui="writing"><textarea id="own"></textarea></div>
        `);
        expect(isWritingEditor(doc.querySelector('#ta'), 'generic')).toBe(true);
        expect(isWritingEditor(doc.querySelector('#text'), 'generic')).toBe(true);
        expect(isWritingEditor(doc.querySelector('#plain'), 'generic')).toBe(true);
        expect(isWritingEditor(doc.querySelector('#pw'), 'generic')).toBe(false);
        expect(isWritingEditor(doc.querySelector('#ce'), 'generic')).toBe(true);
        expect(isWritingEditor(doc.querySelector('#bare-ce'), 'generic')).toBe(true);
        expect(isWritingEditor(doc.querySelector('#aria-disabled-ce'), 'generic')).toBe(false);
        expect(isWritingEditor(doc.querySelector('#aria-readonly-ce'), 'generic')).toBe(false);
        expect(isWritingEditor(doc.querySelector('#pt'), 'generic')).toBe(true);
        expect(isWritingEditor(doc.querySelector('#div'), 'generic')).toBe(false);
        expect(isWritingEditor(doc.querySelector('#own'), 'generic')).toBe(false);

        expect(resolveEditableTarget(null, 'generic')).toBeNull();
        expect(resolveEditableTarget(doc.querySelector('#child'), 'generic')).toBe(doc.querySelector('#ce'));
        // contenteditable="false" island and nested non-editable/password controls must NOT escape to ancestor editor.
        expect(resolveEditableTarget(doc.querySelector('#island'), 'generic')).toBeNull();
        expect(resolveEditableTarget(doc.querySelector('#nested-pw'), 'generic')).toBeNull();
        expect(resolveEditableTarget(doc.querySelector('#nested-disabled'), 'generic')).toBeNull();
        expect(resolveEditableTarget(doc.querySelector('#nested-select'), 'generic')).toBeNull();
        expect(resolveEditableTarget(doc.querySelector('#nested-btn'), 'generic')).toBeNull();
        expect(resolveEditableTarget(doc.querySelector('#nested-role-btn'), 'generic')).toBeNull();
        // Child inside contenteditable on a site that does not accept contenteditable (github) returns null.
        expect(resolveEditableTarget(doc.querySelector('#child'), 'github')).toBeNull();
        expect(resolveEditableTarget(doc.querySelector('#div'), 'generic')).toBeNull();
        expect(findReplyEditors(doc, 'generic')).toEqual([]);
        expect(findReplyActionAnchor(doc.querySelector<HTMLElement>('#ta')!, 'generic')).toBeNull();
    });

    it('pierces open Shadow DOM for deepActiveElement, guards cycles/depth, and ignores FluentRead UI descendants', () => {
        const {doc} = page('<div id="host"></div><div id="own" data-fluent-read-ui="writing"><div id="own-child"></div></div>');
        const host = doc.querySelector<HTMLElement>('#host')!;
        const inner = doc.createElement('textarea');
        Object.defineProperty(host, 'shadowRoot', {value: {activeElement: inner}});
        Object.defineProperty(doc, 'activeElement', {configurable: true, value: host});
        expect(deepActiveElement(doc)).toBe(inner);

        // Descendant inside FluentRead UI returns null via closest(excludedUi).
        const ownChild = doc.querySelector<HTMLElement>('#own-child')!;
        Object.defineProperty(doc, 'activeElement', {configurable: true, value: ownChild});
        expect(deepActiveElement(doc)).toBeNull();

        // Cycle in shadowRoot.activeElement terminates safely.
        const cycleA = doc.createElement('div');
        const cycleB = doc.createElement('div');
        Object.defineProperty(cycleA, 'shadowRoot', {value: {activeElement: cycleB}});
        Object.defineProperty(cycleB, 'shadowRoot', {value: {activeElement: cycleA}});
        Object.defineProperty(doc, 'activeElement', {configurable: true, value: cycleA});
        expect(deepActiveElement(doc)).toBe(cycleB);

        // Pathological >16-level nesting returns null safely.
        let root = doc.createElement('div');
        let current = root;
        for (let i = 0; i < 18; i++) {
            const next = doc.createElement('div');
            Object.defineProperty(current, 'shadowRoot', {value: {activeElement: next}});
            current = next;
        }
        Object.defineProperty(doc, 'activeElement', {configurable: true, value: root});
        expect(deepActiveElement(doc)).toBeNull();

        // Null activeElement returns null cleanly.
        Object.defineProperty(doc, 'activeElement', {configurable: true, value: null});
        expect(deepActiveElement(doc)).toBeNull();
    });

    it('collects bounded generic surrounding context from title, labels, placeholder, and visible paragraphs', () => {
        const {doc} = page(`<article>
            <h1>Feedback Form</h1>
            <p>Tell us how we can improve the product.<span class="fluent-read-bilingual-content">Translated</span></p>
            <label for="f1">Your message</label><textarea id="f1"></textarea>
            <label>Inline label<input id="f2" type="text"></label>
            <textarea id="f3" placeholder="Write a note"></textarea>
            <textarea id="f4" aria-label="Direct aria"></textarea>
            <label hidden for="f5">Hidden label</label><textarea id="f5"></textarea>
            <label for="f6">   </label><textarea id="f6" placeholder="Fallback placeholder"></textarea>
        </article>`);
        doc.title = 'Support Portal';
        const c1 = collectReplyContext(doc, 'generic', doc.querySelector<HTMLElement>('#f1')!);
        expect(c1).toContain('页面标题：Support Portal');
        expect(c1).toContain('输入提示：Your message');
        expect(c1).toContain('Tell us how we can improve the product.');
        expect(c1).not.toContain('Translated');

        expect(collectReplyContext(doc, 'generic', doc.querySelector<HTMLElement>('#f2')!)).toContain('输入提示：Inline label');
        expect(collectReplyContext(doc, 'generic', doc.querySelector<HTMLElement>('#f3')!)).toContain('输入提示：Write a note');
        expect(collectReplyContext(doc, 'generic', doc.querySelector<HTMLElement>('#f4')!)).toContain('输入提示：Direct aria');
        expect(collectReplyContext(doc, 'generic', doc.querySelector<HTMLElement>('#f5')!)).not.toContain('Hidden label');
        expect(collectReplyContext(doc, 'generic', doc.querySelector<HTMLElement>('#f6')!)).toContain('输入提示：Fallback placeholder');
        expect(collectReplyContext(doc, 'generic')).toContain('页面标题：Support Portal');

        const detached = doc.createElement('textarea');
        expect(collectReplyContext(doc, 'generic', detached)).toBe('');
        const empty = page('').doc;
        empty.title = '';
        expect(collectReplyContext(empty, 'generic')).toBe('');
        const noBody = page('').doc;
        noBody.title = '';
        Object.defineProperty(noBody, 'body', {value: null});
        expect(collectReplyContext(noBody, 'generic')).toBe('');
        const emptyBody = page('<p>   </p>').doc;
        emptyBody.title = '';
        expect(collectReplyContext(emptyBody, 'generic')).toBe('');
    });

    it('offers safe copy fallback for ProseMirror, Lexical, Slate, and Draft.js editors without mutating DOM', () => {
        const {doc} = page(`
            <div class="ProseMirror" contenteditable="true">PM content</div>
            <div data-lexical-editor="true" contenteditable="true">Lexical content</div>
            <div data-slate-editor="true" contenteditable="true">Slate content</div>
            <div class="public-DraftEditor-content" contenteditable="true">Draft content</div>
        `);
        for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[contenteditable]'))) {
            expect(hasManagedRichEditor(el)).toBe(true);
            const snap = captureEditor(el, 'https://example.com/editor');
            expect(snap.site).toBe('generic');
            const before = el.innerHTML;
            expect(applyWritingDraft(snap, 'Replaced', snap.url)).toContain('页面框架托管');
            expect(el.innerHTML).toBe(before);
        }
    });

    it('resolves initial writing intent across generic, github, gmail and null sites', () => {
        expect(resolveInitialWritingIntent('generic', 'https://example.com', 'hello', 'ctx')).toBe('polish');
        expect(resolveInitialWritingIntent('generic', 'https://example.com', '', 'ctx')).toBe('draft');
        expect(resolveInitialWritingIntent(null, 'chrome://settings', '', 'ctx')).toBe('draft');
    });
});

describe('Universal writing shortcut runtime', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shortcutMocks.writingMounted = false;
        Object.assign(shortcutMocks.config, new Config());
        registerWritingOpenHandler(null);
        clearPendingWritingOpenTarget();
    });

    it('triggers on-demand mount on generic sites when focused in an editor, and enforces all guards and cleanup', async () => {
        const {doc, win} = page('<textarea id="editor">Hello</textarea><div id="plain">Text</div>');
        const editor = doc.querySelector<HTMLElement>('#editor')!;
        const plain = doc.querySelector<HTMLElement>('#plain')!;
        let active: Element | null = editor;
        Object.defineProperty(doc, 'activeElement', {configurable: true, get: () => active});

        // Already aborted signal exits immediately without listening.
        const aborted = new AbortController();
        aborted.abort();
        mountWritingShortcut(aborted.signal, {
            document: doc, getHref: () => 'https://example.com', isSiteDisabled: () => false,
            mount: shortcutMocks.mountWriting, unmount: shortcutMocks.unmountWriting, isMounted: () => shortcutMocks.writingMounted,
        });

        const controller = new AbortController();
        let siteDisabled = false;
        let href = 'https://example.com/form';
        mountWritingShortcut(controller.signal, {
            document: doc,
            getHref: () => href,
            isSiteDisabled: () => siteDisabled,
            mount: shortcutMocks.mountWriting,
            unmount: shortcutMocks.unmountWriting,
            isMounted: () => shortcutMocks.writingMounted,
        });

        // Untrusted, repeat, IME composing, keyCode 229, global disabled, writing disabled, site disabled, ineligible URL, writing disabledDomains, non-matching key, non-editable focus.
        doc.dispatchEvent(keyEvent(win, {isTrusted: false}));
        doc.dispatchEvent(keyEvent(win, {repeat: true}));
        doc.dispatchEvent(keyEvent(win, {isComposing: true}));
        doc.dispatchEvent(keyEvent(win, {keyCode: 229}));
        shortcutMocks.config.on = false; doc.dispatchEvent(keyEvent(win)); shortcutMocks.config.on = true;
        shortcutMocks.config.writing.enabled = false; doc.dispatchEvent(keyEvent(win)); shortcutMocks.config.writing.enabled = true;
        siteDisabled = true; doc.dispatchEvent(keyEvent(win)); siteDisabled = false;
        href = 'chrome://settings'; doc.dispatchEvent(keyEvent(win)); href = 'https://example.com/form';
        shortcutMocks.config.writing.disabledDomains = ['example.com']; doc.dispatchEvent(keyEvent(win)); shortcutMocks.config.writing.disabledDomains = [];
        doc.dispatchEvent(keyEvent(win, {key: 'K', code: 'KeyK'}));
        active = plain; doc.dispatchEvent(keyEvent(win)); active = editor;
        expect(shortcutMocks.mountWriting).not.toHaveBeenCalled();

        // Valid trigger when unmounted: mounts on demand & queues open target.
        const event = keyEvent(win);
        doc.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(shortcutMocks.mountWriting).toHaveBeenCalledOnce();
        const received = vi.fn();
        registerWritingOpenHandler(received);
        expect(received).toHaveBeenCalledWith(editor);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        // When already mounted: delivers directly without re-mounting.
        shortcutMocks.writingMounted = true;
        doc.dispatchEvent(keyEvent(win));
        expect(shortcutMocks.mountWriting).toHaveBeenCalledOnce();
        expect(received).toHaveBeenCalledTimes(2);

        // Mount failure clears pending target cleanly.
        registerWritingOpenHandler(null);
        shortcutMocks.writingMounted = false;
        shortcutMocks.mountWriting.mockRejectedValueOnce(new Error('mount failed'));
        doc.dispatchEvent(keyEvent(win));
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        const lateHandler = vi.fn();
        registerWritingOpenHandler(lateHandler);
        expect(lateHandler).not.toHaveBeenCalled();

        // Abort unmounts when mounted.
        shortcutMocks.writingMounted = true;
        controller.abort();
        expect(shortcutMocks.unmountWriting).toHaveBeenCalledOnce();

        // Abort when not mounted does not call unmount.
        const second = new AbortController();
        shortcutMocks.writingMounted = false;
        mountWritingShortcut(second.signal, {
            document: doc, getHref: () => href, isSiteDisabled: () => false,
            mount: shortcutMocks.mountWriting, unmount: shortcutMocks.unmountWriting, isMounted: () => shortcutMocks.writingMounted,
        });
        second.abort();
        expect(shortcutMocks.unmountWriting).toHaveBeenCalledOnce();
    });

    it('coalesces rapid double-presses while mount is in-flight and cancels in-flight mount cleanly on abort', async () => {
        const {doc, win} = page('<textarea id="first"></textarea><textarea id="second"></textarea>');
        const first = doc.querySelector<HTMLElement>('#first')!;
        const second = doc.querySelector<HTMLElement>('#second')!;
        let active: Element | null = first;
        Object.defineProperty(doc, 'activeElement', {configurable: true, get: () => active});

        let resolveMount!: () => void;
        const mount = vi.fn(() => new Promise<void>(resolve => { resolveMount = resolve; }));
        const unmount = vi.fn();
        const controller = new AbortController();
        mountWritingShortcut(controller.signal, {
            document: doc, getHref: () => 'https://example.com', isSiteDisabled: () => false,
            mount, unmount, isMounted: () => false,
        });

        // Press 1 starts mount; press 2 on second editor while mounting reuses in-flight mount and updates target.
        doc.dispatchEvent(keyEvent(win));
        active = second;
        doc.dispatchEvent(keyEvent(win));
        expect(mount).toHaveBeenCalledOnce();
        resolveMount();
        await Promise.resolve(); await Promise.resolve();
        const handler = vi.fn();
        registerWritingOpenHandler(handler);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(second);
        registerWritingOpenHandler(null);

        // Abort during an in-flight mount calls unmount even while isMounted() is false,
        // and a stale rejection after abort must not wipe a subsequent session's pending target.
        let rejectInFlight!: (error: Error) => void;
        mount.mockImplementationOnce(() => new Promise<void>((_res, rej) => { rejectInFlight = rej; }));
        doc.dispatchEvent(keyEvent(win));
        expect(mount).toHaveBeenCalledTimes(2);
        controller.abort();
        expect(unmount).toHaveBeenCalledOnce();

        // Start a fresh session and queue a new target before the old mount rejects.
        const fresh = new AbortController();
        mountWritingShortcut(fresh.signal, {
            document: doc, getHref: () => 'https://example.com', isSiteDisabled: () => false,
            mount: vi.fn(() => new Promise<void>(() => {})), unmount: vi.fn(), isMounted: () => false,
        });
        active = first;
        doc.dispatchEvent(keyEvent(win));
        rejectInFlight(new Error('stale failure'));
        await Promise.resolve(); await Promise.resolve();
        const freshHandler = vi.fn();
        registerWritingOpenHandler(freshHandler);
        expect(freshHandler).toHaveBeenCalledWith(first);
        registerWritingOpenHandler(null);
        fresh.abort();
    });

    it('uses global document and window.location defaults when omitted', () => {
        const {doc, win} = page('<textarea id="ed"></textarea>');
        vi.stubGlobal('document', doc);
        vi.stubGlobal('window', {location: {href: 'https://example.com/'}});
        Object.defineProperty(doc, 'activeElement', {configurable: true, value: doc.querySelector('#ed')});
        const controller = new AbortController();
        mountWritingShortcut(controller.signal, {
            isSiteDisabled: () => false,
            mount: shortcutMocks.mountWriting,
            unmount: shortcutMocks.unmountWriting,
            isMounted: () => shortcutMocks.writingMounted,
        });
        doc.dispatchEvent(keyEvent(win));
        expect(shortcutMocks.mountWriting).toHaveBeenCalledOnce();
        controller.abort();
        vi.unstubAllGlobals();
    });
});

describe('Bidirectional writing hotkey conflict checks', () => {
    it('detects conflicts across clickSelection, quickTranslationProfiles normalization, and translation shortcuts', () => {
        const config = new Config();
        config.writing.enabled = true;
        config.writing.writingHotkey = 'Alt+Shift+W';
        expect(findClickSelectionHotkeyConflict(config, 'Alt+Shift+W')).toBe('写作助手');
        config.writing.enabled = false;
        expect(findClickSelectionHotkeyConflict(config, 'Alt+Shift+W')).toBe('');

        const normalized = normalizeConfig({
            ...new Config(),
            writing: {...new Config().writing, enabled: true, writingHotkey: 'Alt+Shift+W'},
            quickTranslationProfiles: [{
                id: 'q-writing', enabled: true, action: 'hover', hotkey: 'Alt+Shift+W',
                service: '', model: '', targetLanguage: '', displayMode: 'inherit', fullPageMode: 'inherit',
            }],
        });
        expect(normalized.quickTranslationProfiles[0].enabled).toBe(false);

        const reactiveConfig = ref(new Config());
        reactiveConfig.value.writing.enabled = true;
        reactiveConfig.value.writing.writingHotkey = 'Alt+Shift+W';
        const scope = effectScope();
        const shortcuts = scope.run(() => useTranslationShortcutSettings(reactiveConfig))!;
        expect(shortcuts.quickTranslationConflictMessage('Alt+Shift+W')).toContain('quickTranslation.legacyConflictEdit');
        reactiveConfig.value.writing.writingHotkey = '';
        expect(shortcuts.quickTranslationConflictMessage('Alt+Shift+W')).toBe('');
        scope.stop();
    });
});

describe('WritingEntrySettings real SFC behavior', () => {
    let app: App | undefined;
    let doc: Document;
    let win: any;

    afterEach(async () => {
        app?.unmount();
        app = undefined;
        await nextTick();
        vi.unstubAllGlobals();
    });

    it('renders shortcut hint, radio scopes, error alert, saving state, keyboard loop, and emits save/close/settings', async () => {
        const parsed = parseHTML('<html><body><div id="mount"></div></body></html>');
        doc = parsed.document;
        win = parsed.window;
        for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'SVGElement']) {
            vi.stubGlobal(key, key === 'window' ? win : win[key]);
        }

        const state = shallowReactive({
            active: false,
            dark: false,
            saving: false,
            error: '',
            hotkey: 'Alt+Shift+W',
        });
        const onClose = vi.fn();
        const onSave = vi.fn();
        const onSettings = vi.fn();

        const host = doc.querySelector('#mount')!;
        const renderer = createRenderer<Node, Element>({
            createElement: (tag, ns) => markRaw(ns === 'svg' ? doc.createElementNS('http://www.w3.org/2000/svg', tag) : doc.createElement(tag)),
            createText: text => doc.createTextNode(text),
            createComment: text => doc.createComment(text),
            insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null),
            remove: node => node.parentNode?.removeChild(node),
            setText: (node, text) => { node.nodeValue = text; },
            setElementText: (node, text) => { node.textContent = text; },
            parentNode: node => node.parentNode as Element | null,
            nextSibling: node => node.nextSibling,
            setScopeId: (node, id) => node.setAttribute(id, ''),
            patchProp(node, key, old, value) {
                if (/^on[A-Z]/u.test(key)) {
                    const type = key.slice(2).toLowerCase();
                    if (old) node.removeEventListener(type, old);
                    if (value) node.addEventListener(type, value);
                } else if (key === 'style') {
                    const style = (node as HTMLElement).style;
                    if (typeof value === 'string') style.cssText = value;
                    else Object.assign(style, value || {});
                } else if (key === 'class') {
                    node.className = typeof value === 'string' ? value : Object.entries(value || {}).filter(([, active]) => active).map(([name]) => name).join(' ');
                } else if (key === 'value') {
                    (node as HTMLInputElement).value = value ?? '';
                } else if (key === 'checked') {
                    (node as HTMLInputElement).checked = Boolean(value);
                } else if (value == null || (value === false && key === 'disabled')) {
                    node.removeAttribute(key);
                } else {
                    node.setAttribute(key, String(value));
                }
            },
            insertStaticContent(html, parent, anchor) {
                const box = doc.createElement('div');
                box.innerHTML = html;
                const first = box.firstChild!, last = box.lastChild!;
                while (box.firstChild) parent.insertBefore(box.firstChild, anchor || null);
                return [first, last];
            },
        });
        app = renderer.createApp({
            setup: () => () => h(WritingEntrySettings, {
                active: state.active,
                dark: state.dark,
                saving: state.saving,
                error: state.error,
                hotkey: state.hotkey,
                onClose,
                onSave,
                onSettings,
            }),
        });
        app.mount(host);
        await nextTick();

        // Open dialog and verify shortcut hint + focus on checked radio.
        state.active = true;
        await nextTick(); await nextTick();
        const section = host.querySelector<HTMLElement>('.writing-entry-settings')!;
        expect(host.querySelector('[data-writing-entry-hotkey]')?.textContent).toContain('Alt+Shift+W');

        // Dark mode & error message.
        state.dark = true;
        state.error = 'Save error';
        await nextTick();
        expect(section.classList.contains('is-dark')).toBe(true);
        expect(section.querySelector('[role="alert"]')?.textContent).toBe('Save error');

        // Select 'site' radio and save.
        const radios = Array.from(section.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
        radios[1].checked = true;
        radios[1].dispatchEvent(new win.Event('change', {bubbles: true}));
        await nextTick();
        section.querySelector<HTMLButtonElement>('button.primary')!.click();
        expect(onSave).toHaveBeenCalledWith('site');

        // Settings button & Cancel button.
        section.querySelector<HTMLButtonElement>('button.settings-link')!.click();
        expect(onSettings).toHaveBeenCalledOnce();
        section.querySelector<HTMLButtonElement>('header button.icon')!.click();
        expect(onClose).toHaveBeenCalledOnce();

        // Keyboard Escape closes when not saving, blocked while saving.
        const esc = new win.Event('keydown', {bubbles: true, cancelable: true});
        Object.assign(esc, {key: 'Escape'});
        section.dispatchEvent(esc);
        expect(onClose).toHaveBeenCalledTimes(2);

        state.saving = true;
        await nextTick();
        const escSaving = new win.Event('keydown', {bubbles: true, cancelable: true});
        Object.assign(escSaving, {key: 'Escape'});
        section.dispatchEvent(escSaving);
        expect(onClose).toHaveBeenCalledTimes(2);
        // Tab when all controls disabled prevents default cleanly.
        const tabDisabled = new win.Event('keydown', {bubbles: true, cancelable: true});
        Object.assign(tabDisabled, {key: 'Tab'});
        section.dispatchEvent(tabDisabled);
        expect(tabDisabled.defaultPrevented).toBe(true);

        // Tab & Shift+Tab focus loop when enabled.
        state.saving = false;
        await nextTick();
        const controls = Array.from(section.querySelectorAll<HTMLElement>('button:not(:disabled), input:checked:not(:disabled)'));
        const focusFirst = vi.spyOn(controls[0], 'focus');
        const focusLast = vi.spyOn(controls.at(-1)!, 'focus');
        Object.defineProperty(doc, 'activeElement', {configurable: true, value: controls[0]});
        const shiftTab = new win.Event('keydown', {bubbles: true, cancelable: true});
        Object.assign(shiftTab, {key: 'Tab', shiftKey: true});
        section.dispatchEvent(shiftTab);
        expect(focusLast).toHaveBeenCalledOnce();

        Object.defineProperty(doc, 'activeElement', {configurable: true, value: controls.at(-1)!});
        const forwardTab = new win.Event('keydown', {bubbles: true, cancelable: true});
        Object.assign(forwardTab, {key: 'Tab', shiftKey: false});
        section.dispatchEvent(forwardTab);
        expect(focusFirst).toHaveBeenCalledOnce();
    });
});
