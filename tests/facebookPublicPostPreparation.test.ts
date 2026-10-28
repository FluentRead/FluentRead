/** Facebook 测试前置回归：作者化原生结构、完整公有正文、单次普通关闭与失败原样传播。 */
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';

const require = createRequire(import.meta.url);
const {FACEBOOK_PUBLIC_POST_SELECTORS: selectors, isSupportedFacebookPublicPostUrl,
    isVerifiedFacebookPublicPostPreparation, readFacebookPublicPostHydrationInPage: readHydration,
    readFacebookPublicPostPreparationStateInPage: readState,
    readFacebookCaptionSnapshotInPage: readCaption, prepareFacebookPublicPost} =
    require('../scripts/site-translation/facebook-public-post-preparation.cjs');
const expectedUrl = 'https://www.facebook.com/FixturePublisher/posts/a-public-story/123/';
const message = 'First\nSecondNASA';

function fixture() {
    // Authored structure derived from the observed relationship, not a copied native caption or account state.
    const {document} = parseHTML(`<html><head><link rel="canonical" href="${expectedUrl}"></head><body>
      <div id="scrollview" aria-hidden="true"><div id="post-dialog" role="dialog" aria-modal="true">
        <div role="button" aria-label="关闭" tabindex="0"></div>
        <div role="article" aria-posinset="1">
          <a id="author" role="link" tabindex="0" aria-label="Fixture Publisher" href="https://www.facebook.com/FixturePublisher">Fixture Publisher</a>
          <a id="permalink" role="link" tabindex="0" aria-label="2024年11月14日" href="https://www.facebook.com/FixturePublisher/posts/pfbidFixture">2024年11月14日</a>
          <div data-ad-preview="message" data-ad-comet-preview="message">First<br>Second<a href="https://public.example/?tracking=PRIVATE_QUERY">NASA</a></div>
          <div role="article" aria-label="评论者：Fixture Reader"><a role="link" tabindex="0" aria-label="1年前" href="https://www.facebook.com/FixturePublisher/posts/pfbidFixture">1年</a></div>
        </div>
      </div></div>
      <div id="promotion" role="dialog" aria-modal="true">
        <div role="button" aria-label="关闭" tabindex="0"><svg><path></path></svg></div>
        <form id="login_popup_cta_form"><input type="password"><div role="button" aria-label="登录">登录</div></form>
      </div></body></html>`);
    const state = {document: document as any, styleCalls: [] as Element[], obstructClose: false,
        obstructMessage: false, url: expectedUrl, rangeVisible: true};
    for (const node of state.document.querySelectorAll('*')) node.getBoundingClientRect = () => ({x: 100, y: 10, width: 24, height: 24});
    state.document.createRange = () => ({selectNodeContents() {}, getClientRects: () => state.rangeVisible ? [{x: 20, y: 100, width: 200, height: 20}] : []});
    state.document.elementFromPoint = (_x: number, y: number) => y < 50
        ? state.obstructClose ? state.document.body : state.document.querySelector(selectors.close)
        : state.obstructMessage ? state.document.body : state.document.querySelector(selectors.message);
    vi.stubGlobal('document', state.document);vi.stubGlobal('location', new URL(state.url));
    vi.stubGlobal('innerWidth', 1280);vi.stubGlobal('innerHeight', 900);vi.stubGlobal('NodeFilter', {SHOW_TEXT: 4});
    vi.stubGlobal('getComputedStyle', (node: Element) => {
        state.styleCalls.push(node);
        return {display: node.getAttribute('data-test-display') || 'block', visibility: node.getAttribute('data-test-visibility') || 'visible',
            opacity: node.getAttribute('data-test-opacity') || '1'};
    });
    return state;
}
type Fixture = ReturnType<typeof fixture>;
const stateInPage = (state: Fixture, afterDismissal = false) => readState({expectedUrl: state.url, afterDismissal});
const dismissHost = (state: Fixture) => {
    state.document.querySelector(selectors.dialog).remove();
    state.document.getElementById('scrollview').removeAttribute('aria-hidden');
};

function fakePage(state: Fixture, options: {onClick?: () => void; clickError?: unknown; keepPromotion?: boolean;
    beforeEvaluate?: (fn: Function) => void; beforeWait?: (fn: Function) => void; waitError?: unknown;
    disposeError?: unknown} = {}) {
    const calls: {action: string; selector?: string; timeout?: number; polling?: number}[] = [];
    let handleDisposals = 0;
    // Compile each page function in isolation, exactly as a serialized evaluate callback with no module closure.
    const inPage = (fn: Function, arg?: unknown) => Function('return (' + fn.toString() + ');')()(arg);
    const page = {
        calls, get handleDisposals() {return handleDisposals;}, url: () => state.url,
        evaluate: async (fn: Function, arg?: unknown) => {options.beforeEvaluate?.(fn);return inPage(fn, arg);},
        locator: (selector: string) => ({click: async (configuration: {timeout: number}) => {
            calls.push({action: 'native-click', selector, ...configuration});
            if (options.clickError) throw options.clickError;
            if (!options.keepPromotion) dismissHost(state);
            options.onClick?.();
        }}),
        waitForFunction: async (fn: Function, arg: unknown, configuration: {timeout: number; polling: number}) => {
            calls.push({action: 'native-state-poll', ...configuration});
            options.beforeWait?.(fn);
            if (options.waitError) throw options.waitError;
            if (!inPage(fn, arg)) throw new Error('Native readiness predicate remained false');
            return {dispose: async () => {handleDisposals++;if (options.disposeError) throw options.disposeError;}};
        },
    };
    return page;
}

function loadingPostShell(state: Fixture) {
    // 同轮原生失败结构：标题已挂载，article 尚无 posinset/message，内部只有空加载占位。
    const d = state.document, post = d.getElementById('post-dialog'), article = post.querySelector('[role="article"]');
    const content = [...article.childNodes];
    post.setAttribute('aria-labelledby', 'native-post-label');
    post.insertAdjacentHTML('afterbegin', '<h2 dir="auto"><span id="native-post-label" dir="auto">Fixture Publisher 的帖子</span></h2>');
    article.removeAttribute('aria-posinset');
    article.innerHTML = '<div role="status" data-visualcompletion="loading-state" aria-label="正在加载..." tabindex="-1"><div><div></div></div></div>';
    return {post, article, status: article.firstElementChild, heading: post.querySelector('h2'),
        label: d.getElementById('native-post-label'), hydrate() {article.setAttribute('aria-posinset', '1');article.replaceChildren(...content);}};
}

afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('bounded native Facebook hydration before strict preparation', () => {
    it('focus failure before native dismissal prevents the click', async () => {
        const state = fixture(), page = fakePage(state);
        const failure = Object.assign(new Error('focus lost'), {code: 'FOCUS_SAFETY_VIOLATION'});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000, () => {throw failure;})).rejects.toBe(failure);
        expect(page.calls.some(call => call.action === 'native-click')).toBe(false);
    });
    it('waits for the exact native loading article and IDREF title, then applies every original preparation guard', async () => {
        const state = fixture(), shell = loadingPostShell(state), source = state.document.documentElement.outerHTML;
        expect(readHydration({expectedUrl})).toBe(false);
        expect(state.document.documentElement.outerHTML).toBe(source);
        const page = fakePage(state, {beforeWait(fn) {if (fn === readHydration) shell.hydrate();}});
        const result = await prepareFacebookPublicPost(page, expectedUrl, 1000);
        expect(result).toMatchObject({hydrationWaited: true, nativeClicks: 1, sourceAndLinksUnchanged: true});
        expect(result.captionParts.map((part: {text: string}) => part.text).join('')).toBe(message);
        expect(page.calls.map(call => call.action)).toEqual(['native-state-poll', 'native-click', 'native-state-poll']);
        expect(page.handleDisposals).toBe(2);
        expect(isVerifiedFacebookPublicPostPreparation(result, page)).toBe(true);
    });

    it('keeps a permanently empty native loading article bounded and never authorizes a close', async () => {
        const state = fixture();loadingPostShell(state);
        const failure: any = new Error('Original native loading shell timeout'), page = fakePage(state, {waitError: failure});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toBe(failure);
        expect(failure.facebookPreparation).toMatchObject({stage: 'hydration', hydrationWaited: true, nativeClicks: 0, nativeClickAttempts: 0});
        expect(page.calls.map(call => call.action)).toEqual(['native-state-poll']);
        expect(isVerifiedFacebookPublicPostPreparation(failure.facebookPreparation, page)).toBe(false);
    });

    it.each(['article-text', 'outside-heading-text', 'missing-status', 'wrong-status-role', 'wrong-loading-marker',
        'unknown-loading-locale', 'multiple-status', 'multiple-article', 'wrong-posinset', 'reading-markup',
        'missing-heading', 'multiple-heading', 'wrong-idref', 'multiple-idrefs', 'duplicate-id', 'label-outside-heading',
        'extra-heading-text', 'missing-promotion', 'nested-promotion', 'outside-scrollview', 'another-dialog',
        'alertdialog', 'form', 'editor', 'link', 'owned-root', 'owned-child', 'owned-ancestor', 'extra-close', 'wrong-close'])
    ('refuses an unrecognized loading-shell relationship before any pointer action: %s', async variant => {
        const state = fixture(), d = state.document, shell = loadingPostShell(state);
        if (variant === 'article-text') shell.status.append('Public-looking content is not an empty shell');
        if (variant === 'outside-heading-text') shell.post.append('An unknown dialog message');
        if (variant === 'missing-status') shell.status.remove();
        if (variant === 'wrong-status-role') shell.status.setAttribute('role', 'region');
        if (variant === 'wrong-loading-marker') shell.status.setAttribute('data-visualcompletion', 'other');
        if (variant === 'unknown-loading-locale') shell.status.setAttribute('aria-label', 'Loading...');
        if (variant === 'multiple-status') shell.article.append(shell.status.cloneNode(true));
        if (variant === 'multiple-article') shell.article.after(shell.article.cloneNode(true));
        if (variant === 'wrong-posinset') shell.article.setAttribute('aria-posinset', '2');
        if (variant === 'reading-markup') shell.status.insertAdjacentHTML('beforeend', '<p></p>');
        if (variant === 'missing-heading') shell.heading.remove();
        if (variant === 'multiple-heading') shell.heading.after(shell.heading.cloneNode(true));
        if (variant === 'wrong-idref') shell.post.setAttribute('aria-labelledby', 'different-native-post-label');
        if (variant === 'multiple-idrefs') shell.post.setAttribute('aria-labelledby', 'native-post-label different-label');
        if (variant === 'duplicate-id') d.body.insertAdjacentHTML('beforeend', '<span id="native-post-label"></span>');
        if (variant === 'label-outside-heading') shell.post.append(shell.label);
        if (variant === 'extra-heading-text') shell.heading.append('Additional header content');
        if (variant === 'missing-promotion') d.getElementById('promotion').remove();
        if (variant === 'nested-promotion') shell.post.append(d.getElementById('promotion'));
        if (variant === 'outside-scrollview') d.body.append(shell.post);
        if (variant === 'another-dialog') d.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true"></div>');
        if (variant === 'alertdialog') shell.post.setAttribute('role', 'alertdialog');
        if (variant === 'form') shell.post.insertAdjacentHTML('beforeend', '<form><input></form>');
        if (variant === 'editor') shell.post.insertAdjacentHTML('beforeend', '<div contenteditable="true"></div>');
        if (variant === 'link') shell.post.insertAdjacentHTML('beforeend', '<a href="https://public.example/"></a>');
        if (variant === 'owned-root') shell.post.setAttribute('data-fr-translation-owned', 'true');
        if (variant === 'owned-child') shell.status.firstElementChild.setAttribute('data-fr-translation-segment', 'true');
        if (variant === 'owned-ancestor') d.getElementById('scrollview').setAttribute('data-fr-translation-owned', 'true');
        if (variant === 'extra-close') shell.post.append(shell.post.querySelector('[role="button"]').cloneNode(true));
        if (variant === 'wrong-close') shell.post.querySelector('[role="button"]').setAttribute('aria-label', 'Close');
        const page = fakePage(state);
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow(variant === 'nested-promotion'
            ? 'hydration refused: promotion ambiguous' : 'hydration refused: unrecognized dialog');
        expect(page.calls).toEqual([]);
    });

    it('refuses new dialog content during the same bounded shell poll instead of proceeding to a click', async () => {
        const state = fixture(), shell = loadingPostShell(state);
        const page = fakePage(state, {beforeWait(fn) {if (fn === readHydration) shell.post.append('An unknown security notice');}});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('hydration refused: unrecognized dialog');
        expect(page.calls.map(call => call.action)).toEqual(['native-state-poll']);
    });

    it('waits on an initially empty public shell then runs the same strict source/links/native close protocol', async () => {
        const state = fixture(), children = [...state.document.body.childNodes];state.document.body.replaceChildren();
        expect(readHydration({expectedUrl})).toBe(false);
        const page = fakePage(state, {beforeWait(fn) {if (fn === readHydration) state.document.body.append(...children);}});
        const result = await prepareFacebookPublicPost(page, expectedUrl, 1000);
        expect(result).toMatchObject({hydrationWaited: true, nativeClicks: 1, sourceAndLinksUnchanged: true});
        expect(result.captionParts.map((part: {text: string}) => part.text).join('')).toBe(message);
        expect(page.calls.map(call => call.action)).toEqual(['native-state-poll', 'native-click', 'native-state-poll']);
        expect(page.handleDisposals).toBe(2);expect(isVerifiedFacebookPublicPostPreparation(result, page)).toBe(true);
    });

    it('keeps a hydration timeout as the same original error and records zero pointer actions', async () => {
        const state = fixture();state.document.body.replaceChildren();
        const failure: any = new Error('Original browser hydration timeout'), page = fakePage(state, {waitError: failure});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toBe(failure);
        expect(failure.facebookPreparation).toMatchObject({stage: 'hydration', hydrationWaited: true, nativeClicks: 0, nativeClickAttempts: 0});
        expect(page.calls.map(call => call.action)).toEqual(['native-state-poll']);
        expect(isVerifiedFacebookPublicPostPreparation(failure.facebookPreparation, page)).toBe(false);
    });

    it.each(['wrong-url', 'wrong-canonical', 'duplicate-canonical', 'malformed-canonical', 'captcha', 'ambiguous-message',
        'unknown-dialog', 'unknown-hidden-dialog'])(
        'never treats unsafe rendered state as loading: %s', async variant => {
            const state = fixture(), d = state.document;
            if (variant === 'ambiguous-message') d.querySelector(selectors.message).after(d.querySelector(selectors.message).cloneNode(true));
            else d.body.replaceChildren();
            if (variant === 'wrong-url') vi.stubGlobal('location', new URL('https://www.facebook.com/checkpoint/'));
            if (variant === 'wrong-canonical') d.querySelector('link[rel="canonical"]').setAttribute('href', 'https://www.facebook.com/Other/posts/123/');
            if (variant === 'duplicate-canonical') d.head.append(d.querySelector('link[rel="canonical"]').cloneNode(true));
            if (variant === 'malformed-canonical') d.querySelector('link[rel="canonical"]').setAttribute('href', 'https://[');
            if (variant === 'captcha') d.body.insertAdjacentHTML('beforeend', '<iframe src="https://public.example/captcha"></iframe>');
            if (variant.startsWith('unknown')) d.body.insertAdjacentHTML('beforeend', `<div role="dialog" ${variant.includes('hidden') ? 'aria-hidden="true"' : ''}></div>`);
            const page = fakePage(state);
            await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('hydration refused');
            expect(page.calls).toEqual([]);
        });

    it('refuses a new unsafe canonical observed during polling rather than waiting or clicking through it', async () => {
        const state = fixture();state.document.body.replaceChildren();
        const page = fakePage(state, {beforeWait() {state.document.querySelector('link[rel="canonical"]').setAttribute('href', 'https://www.facebook.com/Other/posts/123/');}});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('canonical public URL mismatch');
        expect(page.calls.filter(call => call.action === 'native-click')).toEqual([]);
    });

    it('does not bypass the reviewed close shape after the public shell hydrates', async () => {
        const state = fixture(), children = [...state.document.body.childNodes];state.document.body.replaceChildren();
        const page = fakePage(state, {beforeWait(fn) {
            if (fn === readHydration) {state.document.body.append(...children);state.document.querySelector(selectors.close).setAttribute('aria-label', 'Close');}
        }});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('reviewed Chinese native close shape changed');
        expect(page.calls.filter(call => call.action === 'native-click')).toEqual([]);
    });

    it('uses the original total deadline after hydration consumes time', async () => {
        let clock = 0;vi.spyOn(Date, 'now').mockImplementation(() => clock);
        const state = fixture(), children = [...state.document.body.childNodes];state.document.body.replaceChildren();
        const page = fakePage(state, {beforeWait(fn) {if (fn === readHydration) {clock = 40;state.document.body.append(...children);}}});
        await prepareFacebookPublicPost(page, expectedUrl, 100);
        expect(page.calls[0]).toMatchObject({action: 'native-state-poll', timeout: 100});
        expect(page.calls[1]).toMatchObject({action: 'native-click', timeout: 60});
        expect(page.calls[2]).toMatchObject({action: 'native-state-poll', timeout: 60});
    });
});

describe('Facebook public-post preparation URL and native scope', () => {
    it.each([
        'https://www.facebook.com/NASA/posts/look-up-this-week/1116021799893195/',
        'https://www.facebook.com/NASA/posts/pfbidNativePermalink', expectedUrl,
    ])('supports only the observed www public-post family: %s', url => {
        expect(isSupportedFacebookPublicPostUrl(url)).toBe(true);
        const state = fixture(), profile = new URL(url).pathname.split('/')[1];
        state.url = url;vi.stubGlobal('location', new URL(url));
        state.document.querySelector('link[rel="canonical"]').setAttribute('href', url);
        state.document.getElementById('permalink').setAttribute('href', `https://www.facebook.com/${profile}/posts/pfbidFixture`);
        expect(stateInPage(state).action).toBe('dismiss');
    });

    it.each([
        'http://www.facebook.com/NASA/posts/123/', 'https://facebook.com/NASA/posts/123/',
        'https://www.facebook.com.evil.example/NASA/posts/123/', 'https://m.facebook.com/NASA/posts/123/',
        'https://www.facebook.com:8443/NASA/posts/123/', 'https://user:private@www.facebook.com/NASA/posts/123/',
        'https://www.facebook.com/NASA/', 'https://www.facebook.com/NASA/posts/',
        'https://www.facebook.com/NASA/posts//123/', 'https://www.facebook.com/login/',
        'https://www.facebook.com/NASA/POSTS/123/', 'not a URL', null, 123,
    ])('rejects unsupported URL before any page operation: %s', async url => {
        expect(isSupportedFacebookPublicPostUrl(url)).toBe(false);
        const page = {evaluate: vi.fn()};
        await expect(prepareFacebookPublicPost(page, url, 1000)).rejects.toThrow('exact HTTPS www.facebook.com public post');
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('requires exactly one native post/message/canonical and native same-profile date permalink, independently of the URL slug', () => {
        const state = fixture(), before = state.document.documentElement.outerHTML;
        expect(stateInPage(state)).toMatchObject({action: 'dismiss', backgroundPost: {nativeAriaHiddenRoot: 'scrollview', blockers: 1},
            readingPostScope: {dialogSelector: selectors.readingDialog, canonicalMatchesExpected: true,
                nativePermalinkCount: 1, separateNativePostDialog: true}});
        expect(state.document.documentElement.outerHTML).toBe(before);
        expect(state.styleCalls).not.toContain(state.document.querySelector(selectors.message));
    });

    it.each(['missing-canonical', 'duplicate-canonical', 'wrong-canonical', 'missing-permalink', 'duplicate-permalink',
        'wrong-profile', 'wrong-permalink-host', 'empty-permalink-label', 'empty-permalink-text', 'missing-public-article',
        'message-in-promotion', 'two-messages', 'nested-reading-dialog'])('rejects changed native ownership: %s', variant => {
        const state = fixture(), d = state.document, canonical = d.querySelector('link[rel="canonical"]'), permalink = d.getElementById('permalink');
        if (variant === 'missing-canonical') canonical.remove();
        if (variant === 'duplicate-canonical') canonical.after(canonical.cloneNode(true));
        if (variant === 'wrong-canonical') canonical.setAttribute('href', 'https://www.facebook.com/Other/posts/123/');
        if (variant === 'missing-permalink') permalink.remove();
        if (variant === 'duplicate-permalink') permalink.after(permalink.cloneNode(true));
        if (variant === 'wrong-profile') permalink.setAttribute('href', 'https://www.facebook.com/Other/posts/pfbidFixture');
        if (variant === 'wrong-permalink-host') permalink.setAttribute('href', 'https://www.facebook.com.evil.example/FixturePublisher/posts/123/');
        if (variant === 'empty-permalink-label') permalink.setAttribute('aria-label', ' ');
        if (variant === 'empty-permalink-text') permalink.textContent = ' ';
        if (variant === 'missing-public-article') d.querySelector('[aria-posinset="1"]').removeAttribute('aria-posinset');
        if (variant === 'message-in-promotion') d.getElementById('promotion').append(d.querySelector(selectors.message));
        if (variant === 'two-messages') d.querySelector(selectors.message).after(d.querySelector(selectors.message).cloneNode(true));
        if (variant === 'nested-reading-dialog') {const n = d.createElement('div');n.setAttribute('role', 'dialog');n.setAttribute('aria-modal', 'true');d.getElementById('scrollview').append(n);n.append(d.getElementById('post-dialog'));}
        expect(() => stateInPage(state)).toThrow('refused');
    });

    it.each(['unknown-modal', 'unknown-hidden-dialog', 'challenge-frame', 'owned-message', 'owned-close-child', 'message-editor', 'permalink-owned', 'permalink-owned-child'])('rejects unsafe native evidence: %s', variant => {
        const state = fixture(), d = state.document;
        if (variant.startsWith('unknown')) d.body.insertAdjacentHTML('beforeend', `<div role="alertdialog" ${variant.includes('hidden') ? 'aria-hidden="true"' : ''}></div>`);
        if (variant === 'challenge-frame') d.body.insertAdjacentHTML('beforeend', '<iframe src="https://public.example/captcha"></iframe>');
        if (variant === 'owned-message') d.querySelector(selectors.message).setAttribute('data-fr-translation-owned', 'true');
        if (variant === 'owned-close-child') d.querySelector(selectors.close).firstElementChild.setAttribute('data-fr-translation-owned', 'true');
        if (variant === 'message-editor') d.querySelector(selectors.message).insertAdjacentHTML('beforeend', '<textarea>Private editor</textarea>');
        if (variant === 'permalink-owned') d.getElementById('permalink').setAttribute('data-fr-translation-owned', 'true');
        if (variant === 'permalink-owned-child') d.getElementById('permalink').insertAdjacentHTML('beforeend', '<span class="fluent-read-bilingual-content">译文</span>');
        expect(() => stateInPage(state)).toThrow('refused');
    });

    it.each(['empty', 'uppercase-true', 'plaintext-only', 'inherited-editor', 'close-editor'])(
        'refuses native editing capability before any pointer action: %s', async variant => {
            const state = fixture(), caption = state.document.querySelector(selectors.message);
            if (variant === 'empty') caption.setAttribute('contenteditable', '');
            if (variant === 'uppercase-true') caption.setAttribute('contenteditable', 'TRUE');
            if (variant === 'plaintext-only') caption.setAttribute('contenteditable', 'plaintext-only');
            if (variant === 'inherited-editor') caption.parentElement.setAttribute('contenteditable', 'true');
            if (variant === 'close-editor') state.document.querySelector(selectors.close).setAttribute('contenteditable', '');
            const page = fakePage(state);
            await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('refused');
            expect(page.calls).toEqual([]);
        });

    it('explicit ASCII-case false editing attribute remains an ordinary native public block', () => {
        const state = fixture();state.document.querySelector(selectors.message).setAttribute('contenteditable', 'FALSE');
        expect(stateInPage(state).action).toBe('dismiss');
    });
});

describe('reviewed Chinese rolebutton, native visibility and exact caption', () => {
    it.each([
        ['href', '/login'], ['form', 'login_popup_cta_form'], ['formaction', '/login'], ['formmethod', 'post'],
        ['formenctype', 'text/plain'], ['formtarget', '_self'], ['formnovalidate', ''], ['type', 'button'],
        ['data-fr-evidence-original-href', '/login'], ['data-fr-evidence-original-form', 'form1'],
        ['disabled', ''], ['aria-disabled', 'true'], ['tabindex', '-1'], ['aria-label', 'Close'],
    ])('rejects unreviewed or capable close control %s=%s', (name, value) => {
        const state = fixture();state.document.querySelector(selectors.close).setAttribute(name, value);
        expect(() => stateInPage(state)).toThrow('refused');
    });

    it.each(['link-parent', 'form-parent', 'link-child', 'button-child', 'duplicate', 'native-button'])('never sends alternate close shape: %s', variant => {
        const state = fixture(), d = state.document, close = d.querySelector(selectors.close);
        if (variant === 'link-parent' || variant === 'form-parent') {const wrapper = d.createElement(variant === 'link-parent' ? 'a' : 'form');if (variant === 'link-parent') wrapper.setAttribute('href', '/login');close.before(wrapper);wrapper.append(close);}
        if (variant === 'link-child') close.insertAdjacentHTML('beforeend', '<a href="/login">Sign in</a>');
        if (variant === 'button-child') close.insertAdjacentHTML('beforeend', '<button>Sign in</button>');
        if (variant === 'duplicate') close.after(close.cloneNode(true));
        if (variant === 'native-button') {const button = d.createElement('button');for (const attr of close.attributes) button.setAttribute(attr.name, attr.value);close.replaceWith(button);}
        expect(() => stateInPage(state)).toThrow('refused');
    });

    it.each([['hidden', ''], ['inert', ''], ['aria-hidden', 'true'], ['data-test-display', 'none'],
        ['data-test-visibility', 'hidden'], ['data-test-visibility', 'collapse'], ['data-test-opacity', '0']])(
        'refuses invisible close %s=%s without rewriting attributes', (name, value) => {
            const state = fixture();state.document.querySelector(selectors.close).setAttribute(name, value);
            const before = state.document.documentElement.outerHTML;
            expect(() => stateInPage(state)).toThrow('refused');expect(state.document.documentElement.outerHTML).toBe(before);
        });

    it('rejects obstructed or out-of-viewport normal click points', () => {
        let state = fixture();state.obstructClose = true;expect(() => stateInPage(state)).toThrow('obstructed');
        state = fixture();state.document.querySelector(selectors.close).getBoundingClientRect = () => ({x: 2000, y: 10, width: 24, height: 24});
        expect(() => stateInPage(state)).toThrow('obstructed');
    });

    it.each(['second-hidden-root', 'inert-background', 'hidden-background', 'different-background-id'])('limits background exception: %s', variant => {
        const state = fixture(), root = state.document.getElementById('scrollview');
        if (variant === 'second-hidden-root') state.document.querySelector(selectors.message).setAttribute('aria-hidden', 'true');
        if (variant === 'inert-background') root.setAttribute('inert', '');
        if (variant === 'hidden-background') root.setAttribute('hidden', '');
        if (variant === 'different-background-id') root.id = 'unreviewed-background';
        expect(() => stateInPage(state)).toThrow('background post aria relationship changed');
    });

    it('requires host removal of background hiding and real text hit after one close', () => {
        const state = fixture();expect(stateInPage(state, true)).toBe(false);
        dismissHost(state);expect(stateInPage(state, true)).toMatchObject({action: 'none', messageReadable: true});
        state.obstructMessage = true;expect(stateInPage(state, true)).toBe(false);
        state.obstructMessage = false;state.rangeVisible = false;expect(stateInPage(state, true)).toBe(false);
    });

    it('does not accept hidden post when the known promotion is absent', () => {
        const state = fixture();state.document.querySelector(selectors.dialog).remove();
        expect(() => stateInPage(state)).toThrow('unreadable without active known promotion');
    });

    it('captures complete ordered Text and BR plus exact original href without prefix filtering', () => {
        const state = fixture(), before = state.document.documentElement.outerHTML, snapshot = readCaption();
        expect(snapshot.parts).toEqual([{type: 'text', text: 'First'}, {type: 'br', text: '\n'}, {type: 'text', text: 'Second'}, {type: 'text', text: 'NASA'}]);
        expect(snapshot.parts.map((part: {text: string}) => part.text).join('')).toBe(message);
        expect(snapshot.links[0].href).toBe('https://public.example/?tracking=PRIVATE_QUERY');
        expect(state.document.documentElement.outerHTML).toBe(before);
    });
});

describe('one normal native click, total deadline and immutable success authority', () => {
    it('performs only one normal close, requires full preserved source and authenticates only this returned object', async () => {
        const page = fakePage(fixture()), result = await prepareFacebookPublicPost(page, expectedUrl, 1000);
        expect(result).toMatchObject({status: 'dismissed', url: expectedUrl, hydrationWaited: false, nativeClicks: 1, nativeClickAttempts: 1,
            sourceAndLinksUnchanged: true, accountFormActions: 0, visibilityOrAriaWrites: 0, captionLinkCount: 1});
        expect(page.calls.map(call => call.action)).toEqual(['native-click', 'native-state-poll']);
        expect(page.calls[0]).toMatchObject({selector: selectors.close});
        expect(page.calls[0]).not.toHaveProperty('force');expect(page.handleDisposals).toBe(1);
        expect(isVerifiedFacebookPublicPostPreparation(result)).toBe(true);
        expect(isVerifiedFacebookPublicPostPreparation(result, page)).toBe(true);
        expect(isVerifiedFacebookPublicPostPreparation(result, {...page})).toBe(false);
        expect(isVerifiedFacebookPublicPostPreparation(result, undefined)).toBe(false);
        expect(isVerifiedFacebookPublicPostPreparation({...result})).toBe(false);
        expect(isVerifiedFacebookPublicPostPreparation(JSON.parse(JSON.stringify(result)))).toBe(false);
        expect(isVerifiedFacebookPublicPostPreparation(null)).toBe(false);
        expect(() => {result.readingPostScope.dialogSelector = 'body';}).toThrow();
        expect(JSON.stringify(result)).not.toContain('PRIVATE_QUERY');
    });

    it('already-readable optional promotion takes zero actions and is still fully verified', async () => {
        const state = fixture();dismissHost(state);const page = fakePage(state), result = await prepareFacebookPublicPost(page, expectedUrl, 1000);
        expect(result.status).toBe('not-present');expect(result.nativeClicks).toBe(0);expect(page.calls).toEqual([]);
        expect(isVerifiedFacebookPublicPostPreparation(result)).toBe(true);
    });

    it.each(['text-loss', 'text-extra', 'br-loss', 'same-text-different-parts', 'href-change', 'missing-link', 'extra-link',
        'metadata-href-change', 'metadata-label-change'])('rejects complete snapshot drift after the host closes: %s', async variant => {
        const state = fixture(), page = fakePage(state, {onClick() {
            const d = state.document, caption = d.querySelector(selectors.message), link = caption.querySelector('a');
            if (variant === 'text-loss') caption.firstChild.textContent = 'Fir';
            if (variant === 'text-extra') caption.append(d.createTextNode(' Extra'));
            if (variant === 'br-loss') caption.querySelector('br').remove();
            if (variant === 'same-text-different-parts') caption.firstChild.replaceWith(d.createTextNode('Fi'), d.createTextNode('rst'));
            if (variant === 'href-change') link.setAttribute('href', 'https://public.example/changed');
            if (variant === 'missing-link') link.replaceWith(d.createTextNode(link.textContent));
            if (variant === 'extra-link') caption.insertAdjacentHTML('beforeend', '<a href="https://public.example/new">New</a>');
            if (variant === 'metadata-href-change') d.getElementById('permalink').setAttribute('href', 'https://www.facebook.com/FixturePublisher/posts/pfbidChanged');
            if (variant === 'metadata-label-change') d.getElementById('permalink').setAttribute('aria-label', '2025年11月14日');
        }});
        let failure: any;try {await prepareFacebookPublicPost(page, expectedUrl, 1000);} catch (error) {failure = error;}
        expect(failure?.message).toContain('complete public caption/source links changed');
        expect(failure.facebookPreparation).toMatchObject({status: 'failed', nativeClicks: 1, nativeClickAttempts: 1});
        expect(page.calls.filter(call => call.action === 'native-click')).toHaveLength(1);
        expect(isVerifiedFacebookPublicPostPreparation(failure.facebookPreparation)).toBe(false);
    });

    it('pre-click revalidation rejects a newly capable close instead of delivering an account action', async () => {
        const state = fixture();let reads = 0;
        const page = fakePage(state, {beforeEvaluate(fn) {if (fn === readState && ++reads === 2) state.document.querySelector(selectors.close).setAttribute('formaction', '/login');}});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('navigation/form capability');expect(page.calls).toEqual([]);
    });

    it('preserves original click rejection object and never retries', async () => {
        const failure: any = new Error('Original native click failed'), page = fakePage(fixture(), {clickError: failure});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toBe(failure);
        expect(failure.facebookPreparation).toMatchObject({stage: 'native-close', nativeClickAttempts: 1, nativeClicks: 0});
        expect(page.calls.map(call => call.action)).toEqual(['native-click']);
    });

    it('normal close acknowledgement without actual public readability fails and never clicks again', async () => {
        const page = fakePage(fixture(), {keepPromotion: true});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('Native readiness predicate remained false');
        expect(page.calls.filter(call => call.action === 'native-click')).toHaveLength(1);
    });

    it('URL change after normal click refuses the new page before polling', async () => {
        const state = fixture(), page = fakePage(state, {onClick() {state.url = 'https://www.facebook.com/login/';}});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toThrow('URL changed after normal');
        expect(page.calls.map(call => call.action)).toEqual(['native-click']);
    });

    it('propagates handle-disposal failure without success authority or another action', async () => {
        const failure = new Error('Original handle disposal failed'), page = fakePage(fixture(), {disposeError: failure});
        await expect(prepareFacebookPublicPost(page, expectedUrl, 1000)).rejects.toBe(failure);
        expect(page.calls.filter(call => call.action === 'native-click')).toHaveLength(1);
    });

    it.each([0, -1, Infinity, NaN])('rejects invalid timeout before any page operation: %s', async timeout => {
        const page = {evaluate: vi.fn()};await expect(prepareFacebookPublicPost(page, expectedUrl, timeout)).rejects.toThrow('positive bounded timeout');
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('uses one total deadline with decreasing native action/poll bounds', async () => {
        let clock = 0;vi.spyOn(Date, 'now').mockImplementation(() => clock += 5);
        const page = fakePage(fixture());await prepareFacebookPublicPost(page, expectedUrl, 1000);
        expect(page.calls[0]!.timeout).toBeLessThan(1000);expect(page.calls[1]!.timeout).toBeLessThan(page.calls[0]!.timeout!);
    });

    it('expired preflight budget never becomes a fresh timeout or a click', async () => {
        let clock = 0;vi.spyOn(Date, 'now').mockImplementation(() => clock += 20);
        const page = fakePage(fixture());await expect(prepareFacebookPublicPost(page, expectedUrl, 10)).rejects.toThrow('deadline exceeded');
        expect(page.calls).toEqual([]);
    });
});
