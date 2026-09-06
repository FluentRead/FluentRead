import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {applyWritingDraft, captureEditor, collectReplyContext, findReplyActionAnchor, findReplyEditors, isWritingEditor} from '@/src/features/writing-assistant/editors';

function page(html: string) {
    const doc = parseHTML(`<html><body>${html}</body></html>`).document;
    doc.querySelectorAll<HTMLElement>('*').forEach(element => { element.getClientRects = () => [{}] as never; });
    return doc;
}

describe('Gmail draft insertion preserves plain text', () => {
    const drafts = ['One\nTwo', 'One\n\nTwo', 'One\n', 'One\n\n', '\nOne', '\n\n',
        '  const a = 1;\n\t  return a < 2;\n\nA  B', '<script>bad()</script> <img src=x onerror="bad()"> & "x"', ''];

    it.each(['native', 'unavailable', 'rejected'] as const)('preserves exact paragraphs, code and literal markup through the %s insertion path', mode => {
        const doc = page('<div contenteditable="true" role="textbox">Original draft</div><button type="submit">Send</button>');
        const element = doc.querySelector<HTMLElement>('[contenteditable]')!;
        const selection = {removeAllRanges: vi.fn(), addRange: vi.fn()};
        const range = {selectNodeContents: vi.fn()};
        doc.getSelection = vi.fn(() => selection) as never;
        doc.createRange = vi.fn(() => range) as never;
        const native = vi.fn((command: string, ui: boolean, html: string) => {
            expect(command).toBe('insertHTML'); expect(ui).toBe(false);
            const parsed = page(html).body;
            expect(parsed.querySelector('script, img, a, [onerror]')).toBeNull();
            expect(parsed.children).toHaveLength(1);
            expect(parsed.firstElementChild?.tagName).toBe('SPAN');
            expect((parsed.firstElementChild as HTMLElement).style.whiteSpace).toBe('pre-wrap');
            if (mode === 'native') element.innerHTML = html;
            return mode === 'native';
        });
        if (mode !== 'unavailable') doc.execCommand = native as never;
        const input = vi.fn(); const change = vi.fn(); const send = vi.fn();
        element.addEventListener('input', input); element.addEventListener('change', change);
        doc.querySelector('button')!.addEventListener('click', send);
        const snapshot = captureEditor(element, 'https://mail.google.com/mail/u/0/#inbox/fixture');
        for (const text of drafts) {
            expect(applyWritingDraft(snapshot, text, snapshot.url)).toBeUndefined();
            expect(element.textContent).toBe(text);
            expect(element.firstElementChild?.children).toHaveLength(0);
            expect((element.firstElementChild as HTMLElement).style.whiteSpace).toBe('pre-wrap');
            expect(snapshot.signature).toBe(element.innerHTML);
        }
        expect(native).toHaveBeenCalledTimes(mode === 'unavailable' ? 0 : drafts.length);
        expect(input).toHaveBeenCalledTimes(drafts.length); expect(change).toHaveBeenCalledTimes(drafts.length);
        expect(send).not.toHaveBeenCalled(); expect(range.selectNodeContents).toHaveBeenLastCalledWith(element);
        element.textContent = 'New user edits';
        expect(applyWritingDraft(snapshot, 'Late result', snapshot.url)).toContain('已被修改');
        expect(element.textContent).toBe('New user edits');
        expect(input).toHaveBeenCalledTimes(drafts.length);
    });
});

// 用户提供的 GitHub DOM 仅保留结构：正文、账号、节点动态 ID、属性 URL 与脚本均未复制。
const githubComposer = `<div data-testid="comment-composer">
  <h2 id="comment-composer-heading">Add a comment</h2>
  <div class="IssueCommentComposer-module__commentBoxWrapper__fixture">
    <div class="CommentBox-module__commentBoxContainer__fixture">
      <slash-command-expander><fieldset aria-disabled="false">
        <div class="MarkdownEditor-module__container__fixture">
          <div><div class="MarkdownEditor-module__writeWrapper__fixture">
            <div class="MarkdownInput-module__inputWrapper__fixture"><span>
              <textarea aria-labelledby="comment-composer-heading" placeholder="Use Markdown to format your comment"></textarea>
            </span></div>
          </div></div>
          <div data-testid="markdown-editor-footer"><div class="Footer-module__childrenStyling__fixture">
            <div><button type="button">Close issue</button><button type="button" aria-label="Other actions"></button></div>
            <button type="button" data-variant="primary" aria-disabled="true"><span>Comment</span></button>
            <span data-testid="save-button-tooltip" role="tooltip" aria-hidden="true">Draft required</span>
            <div><template shadowrootmode="open"><div class="immersive-translate-ai-writing-container"><button type="submit">Injected writing</button></div></template></div>
          </div></div>
        </div>
      </fieldset></slash-command-expander>
    </div>
  </div>
</div>`;

describe('Writing editor native action ownership', () => {
    it('recognizes the nameless React issue composer and anchors before its disabled Comment button', () => {
        const doc = page(`<main>${githubComposer}</main><nav><textarea></textarea></nav>
          <div data-fluent-read-ui="writing"><textarea name="comment[body]"></textarea></div>`);
        const editors = findReplyEditors(doc, 'github');
        expect(editors).toHaveLength(1);
        expect(editors[0].getAttribute('aria-labelledby')).toBe('comment-composer-heading');
        const anchor = findReplyActionAnchor(editors[0], 'github')!;
        expect(anchor.textContent).toBe('Comment');
        expect(anchor.getAttribute('aria-disabled')).toBe('true');
        const host = doc.createElement('span');
        anchor.before(host);
        expect(host.nextElementSibling).toBe(anchor);
        expect(host.parentElement?.parentElement?.getAttribute('data-testid')).toBe('markdown-editor-footer');
        expect(doc.querySelector('template button')).not.toBe(anchor);
        editors[0].closest('fieldset')!.setAttribute('aria-disabled', 'true');
        expect(findReplyEditors(doc, 'github')).toEqual([]);
        expect(findReplyActionAnchor(editors[0], 'github')).toBeNull();
    });

    it('keeps separate legacy PR forms bound to their own Comment or Reply action', () => {
        const doc = page(`<main>
          <form><textarea id="new_comment_field" name="comment[body]"></textarea>
            <button type="submit" name="comment_and_close">Close issue</button><button type="submit">Comment</button></form>
          <form class="js-inline-comment-form"><textarea name="discussion_comment[body]"></textarea>
            <button type="button" class="js-comment-button">Reply</button></form>
          <div data-testid="comment-box"><textarea></textarea><button data-testid="comment-button">Comment</button></div>
          <form><textarea name="discussion[body]"></textarea><input type="submit" value="Reply"></form>
        </main>`);
        const editors = findReplyEditors(doc, 'github');
        expect(editors).toHaveLength(4);
        expect(editors.map(editor => findReplyActionAnchor(editor, 'github')?.textContent)).toEqual(['Comment', 'Reply', 'Comment', '']);
        expect(findReplyActionAnchor(editors[3], 'github')?.getAttribute('value')).toBe('Reply');
    });

    it('ignores hidden and injected action candidates without borrowing another composer button', () => {
        const doc = page(`<form><textarea name="comment[body]"></textarea>
          <div hidden><button type="submit">Hidden</button></div>
          <div data-fluent-read-ui><button type="submit">Own UI</button></div>
          <div class="read-frog-react-shadow-host"><button type="submit">Injected UI</button></div>
          <button type="submit">Comment</button></form>
          <form><textarea name="comment[body]"></textarea></form>
          <textarea name="comment[body]"></textarea>`);
        const [first, empty, standalone] = findReplyEditors(doc, 'github');
        expect(findReplyActionAnchor(first, 'github')?.textContent).toBe('Comment');
        expect(findReplyActionAnchor(empty, 'github')).toBeNull();
        expect(findReplyActionAnchor(standalone, 'github')).toBeNull();
        expect(findReplyActionAnchor(first, null)).toBeNull();
    });

    it('finds Gmail send controls inside each compose container across localized labels', () => {
        const doc = page(`<div class="M9"><div contenteditable="true" role="textbox"></div><div role="button" data-tooltip="发送 (⌘Enter)">发送</div></div>
          <div role="dialog"><div contenteditable="true" role="textbox"></div><div role="button" aria-label="Send (Ctrl+Enter)">Send</div></div>
          <form><div contenteditable="true" role="textbox"></div><button type="submit">Send form</button></form>
          <div contenteditable="true" role="textbox"></div>`);
        const editors = findReplyEditors(doc, 'gmail');
        expect(editors.map(editor => findReplyActionAnchor(editor, 'gmail')?.textContent)).toEqual(['发送', 'Send', 'Send form', undefined]);
    });

    it('excludes inactive and injected editors and bounds automatic entries', () => {
        const doc = page(`<fieldset disabled><textarea name="comment[body]"></textarea></fieldset>
          <div inert><textarea name="comment[body]"></textarea></div>
          <div style="display:none"><textarea name="comment[body]"></textarea></div>
          <div style="visibility: hidden"><textarea name="comment[body]"></textarea></div>
          <template><textarea name="comment[body]"></textarea></template>
          <div class="immersive-translate-ai-writing-container"><textarea name="comment[body]"></textarea></div>
          ${'<textarea name="comment[body]"></textarea>'.repeat(15)}`);
        expect(findReplyEditors(doc, 'github')).toHaveLength(12);
        expect(isWritingEditor(doc.querySelector('fieldset textarea'), 'github')).toBe(false);
        expect(isWritingEditor(doc.querySelector('template textarea'), 'github')).toBe(false);
    });
});

describe('Writing context belongs to the selected conversation', () => {
    it('keeps issue 421 about duplicate translations separate from the repository linked in its image-only body', () => {
        const doc = page(`<main><div data-testid="issue-header"><h1><bdi data-testid="issue-title">同一段话出现了两次翻译</bdi></h1></div>
          <div data-testid="issue-metadata-fixed"><span data-testid="header-state"><svg><title>icon</title></svg>Open</span></div>
          <div data-testid="issue-body"><a data-testid="issue-body-header-author">reporter-fixture</a><div data-testid="markdown-body">
            <img src="https://example.test/screenshot.png"><a href="https://github.com/planetscale/vtprotobuf">https://github.com/planetscale/vtprotobuf</a>
          </div></div>${githubComposer}</main><aside><a class="author">unrelated-account</a></aside>`);
        const context = collectReplyContext(doc, 'github', findReplyEditors(doc, 'github')[0], 'https://github.com/FluentRead/FluentRead/issues/421?view=test#issuecomment-fixture');
        expect(context).toBe('当前项目：FluentRead/FluentRead\n帖子类型：Issue #421\n页面地址：https://github.com/FluentRead/FluentRead/issues/421\n帖子标题：同一段话出现了两次翻译\n帖子状态：Open\n发起人：reporter-fixture\n\n原帖：https://github.com/planetscale/vtprotobuf');
        expect(context).not.toContain('unrelated-account');
        expect(context).not.toContain('screenshot.png');
    });

    it('supports legacy PR titles, status, and authors while keeping inline replies inside their own thread', () => {
        const doc = page(`<main><h1 class="gh-header-title"><bdi class="js-issue-title">Preserve the selected source</bdi></h1>
          <div class="gh-header-meta"><span class="State">Merged</span></div>
          <div class="js-issue timeline-comment"><div class="timeline-comment-header"><a class="author">starter-fixture</a></div><div class="js-comment-body">Original proposal</div></div>
          <div data-testid="review-thread"><div class="timeline-comment"><div class="timeline-comment-header"><a class="author">reviewer-fixture</a></div><div class="js-comment-body">Selected review</div></div>
            <form class="js-inline-comment-form"><textarea name="comment[body]"></textarea></form></div>
          <div data-testid="review-thread"><div class="js-comment-body">Other review</div></div>${githubComposer}</main>`);
        const [inline, main] = findReplyEditors(doc, 'github');
        const url = 'https://github.com/example/project/pull/7/files?diff=split#discussion-fixture';
        const context = collectReplyContext(doc, 'github', inline, url);
        expect(context).toBe('当前项目：example/project\n帖子类型：Pull Request #7\n页面地址：https://github.com/example/project/pull/7\n帖子标题：Preserve the selected source\n帖子状态：Merged\n发起人：starter-fixture\n\n当前讨论：回复作者：reviewer-fixture\nSelected review');
        expect(context).not.toContain('Original proposal');
        expect(context).not.toContain('Other review');
        expect(collectReplyContext(doc, 'github', main, url)).toContain('发起人：starter-fixture\n\n原帖：Original proposal');
    });

    it('collects visible React reply authors only from their corresponding comment headers', () => {
        const doc = page(`<main><div data-testid="issue-body"><div data-testid="markdown-body">Initial report</div></div>
          <div data-testid="issue-comment"><a data-testid="issue-comment-header-author">first-reviewer</a><div data-testid="markdown-body">First reply</div></div>
          <div data-testid="issue-comment"><a data-testid="comment-author">second-reviewer</a><div data-testid="markdown-body">Latest reply<a href="/someone" class="author">Body mention</a></div></div>
          <div class="js-comment"><a data-testid="comment-author" hidden>hidden-reviewer</a><div class="js-comment-body">Anonymous visible reply</div></div>${githubComposer}</main>`);
        expect(collectReplyContext(doc, 'github', findReplyEditors(doc, 'github')[0])).toBe('原帖：Initial report\n\n当前讨论：回复作者：first-reviewer\nFirst reply\n\n回复作者：second-reviewer\nLatest replyBody mention\n\nAnonymous visible reply');
    });

    it('omits hidden and injected titles, uses visible legacy fallback, and never copies the generic document title', () => {
        const doc = page(`<main><bdi data-testid="issue-title" hidden>Hidden title</bdi><div data-fluent-read-ui><bdi data-testid="issue-title">Injected title</bdi></div>
          <bdi data-testid="issue-title"> </bdi><div class="gh-header-title"><span class="js-issue-title">Visible title<span hidden>Private detail</span><font class="immersive-translate-target-wrapper">Duplicate title</font></span></div>
          <div class="js-comment-body">Visible body</div>${githubComposer}</main>`);
        doc.title = 'Unrelated generic page title';
        expect(collectReplyContext(doc, 'github', findReplyEditors(doc, 'github')[0])).toBe('帖子标题：Visible title\n\n原帖：Visible body');
        doc.querySelector('.gh-header-title')!.remove();
        expect(collectReplyContext(doc, 'github')).toBe('原帖：Visible body');
        for (const url of ['https://github.com.evil.test/a/b/issues/3', 'http://github.com/a/b/issues/3', 'https://github.com/a/b', '!']) {
            expect(collectReplyContext(doc, 'github', undefined, url)).toBe('原帖：Visible body');
        }
    });

    it('excludes stylesheet-hidden title and body fragments while supporting DOM documents without computed styles', () => {
        const doc = page(`<main><bdi data-testid="issue-title" class="css-hidden">Invisible title</bdi><bdi class="js-issue-title">Visible title<span class="css-hidden">Private title fragment</span></bdi>
          <div class="js-comment-body">Visible body<span class="css-none">Display-none detail</span><span class="css-collapse">Collapsed detail</span></div>
          <div class="js-comment-body css-hidden">Invisible reply</div></main>`);
        doc.defaultView!.getComputedStyle = ((element: Element) => ({display: element.classList.contains('css-none') ? 'none' : 'block', visibility: element.classList.contains('css-hidden') ? 'hidden' : element.classList.contains('css-collapse') ? 'collapse' : 'visible'})) as never;
        expect(collectReplyContext(doc, 'github')).toBe('帖子标题：Visible title\n\n原帖：Visible body');
        Reflect.deleteProperty(doc.defaultView!, 'getComputedStyle');
        const noWindow = page('<main><div class="js-comment-body">Available source</div></main>');
        Object.defineProperty(noWindow, 'defaultView', {value: null});
        expect(collectReplyContext(noWindow, 'github')).toBe('原帖：Available source');
    });

    it('reserves title and identity before long original posts and keeps the newest comment within the total budget', () => {
        const doc = page(`<main><bdi data-testid="issue-title">${'T'.repeat(1400)}</bdi><div data-testid="issue-body"><div data-testid="markdown-body">${'O'.repeat(15000)}</div></div>
          <div class="js-comment-body">${'C'.repeat(15000)}</div><div class="js-comment-body">Latest question?</div>${githubComposer}</main>`);
        const editor = findReplyEditors(doc, 'github')[0];
        const context = collectReplyContext(doc, 'github', editor, 'https://github.com/current/project/issues/4');
        expect(context).toHaveLength(12000);
        expect(context).toContain('帖子标题：' + 'T'.repeat(1000) + '\n\n原帖：' + 'O'.repeat(4000));
        expect(context.endsWith('\n\nLatest question?')).toBe(true);
        expect(context).not.toContain('T'.repeat(1001));
        doc.querySelectorAll('.js-comment-body').forEach(element => element.remove());
        expect(collectReplyContext(doc, 'github', editor)).toHaveLength(12000);
    });

    it('reads only the selected Gmail subject and compose subject without taking background mail or another draft', () => {
        const doc = page(`<main role="main"><h2 class="hP">First conversation</h2><div class="a3s">First mail</div><div role="textbox" contenteditable="true"></div>
          <div class="M9"><input name="subjectbox" value="Own compose subject"><div role="textbox" contenteditable="true"></div></div></main>
          <main role="main"><h2 class="hP">Second conversation</h2><div class="a3s">Second mail</div><div role="textbox" contenteditable="true"></div></main>
          <div role="dialog"><input name="subjectbox" value=""><input name="subjectbox" hidden value="Hidden subject"><div role="textbox" contenteditable="true"></div></div>`);
        const editors = findReplyEditors(doc, 'gmail');
        expect(editors.map(editor => collectReplyContext(doc, 'gmail', editor))).toEqual(['邮件主题：First conversation\n\n当前邮件：First mail', '邮件主题：Own compose subject', '邮件主题：Second conversation\n\n当前邮件：Second mail', '']);
        const compose = editors[1].closest('.M9')!;
        compose.querySelector('input')!.setAttribute('hidden', '');
        expect(collectReplyContext(doc, 'gmail', editors[1])).toBe('');
    });

    it('collects React issue markdown once and removes controls and duplicate translation injections without mutating the page', () => {
        const doc = page(`<main><div data-testid="issue-body"><div data-testid="issue-body-viewer">
          <div data-testid="markdown-body" class="markdown-body"><div class="markdown-body js-comment-body">Source issue.
            <font class="immersive-translate-target-wrapper">Duplicate translation.</font>
            <span class="fluent-read-bilingual-content">Second translation.</span>
            <span data-fr-translation-owned="true">Owned result.</span>
            <span role="button">Expand</span><select><option>Internal choice</option></select>
            <template><div data-testid="markdown-body">Injected template</div></template>
            <div class="read-frog-react-shadow-host"><div data-testid="markdown-body">Injected UI</div></div>
            <div contenteditable="true">Private draft</div><span style="display: none">Hidden detail</span>
          </div></div>
        </div></div>${githubComposer}</main>`);
        const editor = findReplyEditors(doc, 'github')[0];
        const originalHtml = doc.body.innerHTML;
        expect(collectReplyContext(doc, 'github', editor)).toBe('原帖：Source issue.');
        expect(doc.body.innerHTML).toBe(originalHtml);
    });

    it('limits PR replies to the containing review thread for current and legacy thread wrappers', () => {
        for (const marker of ['data-testid="review-thread"', 'class="js-resolvable-timeline-thread-container"', 'class="js-inline-comments-container"']) {
            const doc = page(`<main><div class="js-comment-body">Unrelated issue summary</div>
              <div ${marker}><div class="js-comment-body">Selected review thread</div>
                <form class="js-inline-comment-form"><textarea name="comment[body]"></textarea></form></div>
              <div data-testid="review-thread"><div class="js-comment-body">Another review thread</div></div>
            </main>`);
            expect(collectReplyContext(doc, 'github', findReplyEditors(doc, 'github')[0])).toBe('当前讨论：Selected review thread');
        }
    });

    it('keeps original source text across bilingual translation, single-slot translation, and restore', () => {
        const doc = page('<main><div class="js-comment-body">Original comment</div></main>');
        const body = doc.querySelector('.js-comment-body')!;
        expect(collectReplyContext(doc, 'github')).toBe('原帖：Original comment');
        body.innerHTML = 'Original comment<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">Translated comment</span>';
        expect(collectReplyContext(doc, 'github')).toBe('原帖：Original comment');
        body.innerHTML = '<span class="fluent-read-single-slot" data-fr-translation-owned="true" translate="no">Original comment</span>';
        expect(collectReplyContext(doc, 'github')).toBe('原帖：Original comment');
        body.textContent = 'Original comment';
        expect(collectReplyContext(doc, 'github')).toBe('原帖：Original comment');
    });

    it('uses empty context for a new inline review instead of unrelated page discussion', () => {
        const doc = page('<main><div class="js-comment-body">Other discussion</div><form class="js-inline-comment-form"><textarea name="comment[body]"></textarea></form></main>');
        expect(collectReplyContext(doc, 'github', findReplyEditors(doc, 'github')[0])).toBe('');
        const detachedThread = page('<main><bdi data-testid="issue-title">Background title</bdi><div class="js-comment-body">Background issue</div></main><form class="js-inline-comment-form"><textarea name="comment[body]"></textarea></form>');
        expect(collectReplyContext(detachedThread, 'github', findReplyEditors(detachedThread, 'github')[0])).toBe('');
    });

    it('omits image-only and control-only replies instead of adding empty discussion sections', () => {
        const doc = page('<main><div class="js-comment-body">Original report</div><div class="js-comment-body"><img src="https://example.test/image.png"></div><div class="js-comment-body"><button>Reply controls</button></div></main>');
        expect(collectReplyContext(doc, 'github')).toBe('原帖：Original report');
    });

    it('separates visible Gmail conversations and leaves a new compose draft without background mail context', () => {
        const doc = page(`<main role="main"><div class="a3s">Selected mail conversation</div><div role="textbox" contenteditable="true"></div>
          <div class="M9"><div role="textbox" contenteditable="true"></div></div></main>
          <main role="main"><div class="a3s">Other mail conversation</div><div role="textbox" contenteditable="true"></div></main>
          <div role="dialog"><div role="textbox" contenteditable="true"></div></div>`);
        const editors = findReplyEditors(doc, 'gmail');
        expect(editors.map(editor => collectReplyContext(doc, 'gmail', editor))).toEqual(['当前邮件：Selected mail conversation', '', '当前邮件：Other mail conversation', '']);
    });

    it('rejects disconnected, foreign-document, hidden, and unscoped context targets', () => {
        const doc = page('<main><div class="js-comment-body">Page discussion</div></main><textarea name="comment[body]"></textarea>');
        const editor = findReplyEditors(doc, 'github')[0];
        expect(collectReplyContext(doc, 'github', editor)).toBe('');
        expect(collectReplyContext(doc, 'gmail', editor)).toBe('');
        const foreign = page('<textarea></textarea>').querySelector('textarea')!;
        expect(collectReplyContext(doc, 'github', foreign)).toBe('');
        editor.setAttribute('hidden', '');
        expect(collectReplyContext(doc, 'github', editor)).toBe('');
        editor.removeAttribute('hidden'); editor.remove();
        expect(collectReplyContext(doc, 'github', editor)).toBe('');
    });

    it('keeps the latest twelve bodies, excludes non-visible bodies, and enforces the existing context limit', () => {
        const doc = page(`<main>${Array.from({length: 14}, (_, index) => `<div class="CommentBody">Comment ${index}</div>`).join('')}
          <div class="CommentBody" hidden>Hidden</div><div data-fluent-read-ui><div class="CommentBody">Own UI</div></div></main>`);
        expect(collectReplyContext(doc, 'github')).toBe('原帖：Comment 0\n\n当前讨论：' + Array.from({length: 12}, (_, index) => `Comment ${index + 2}`).join('\n\n'));
        doc.querySelectorAll<HTMLElement>('.CommentBody').forEach(element => { element.textContent = 'x'.repeat(2000); });
        expect(collectReplyContext(doc, 'github')).toHaveLength(12000);
    });

    it('budgets recent questions before old long comments while counting the separators', () => {
        const doc = page(`<main><div class="js-comment-body">${'O'.repeat(15000)}</div>
          <div class="js-comment-body">Latest question?</div><div class="js-comment-body">Newest clarification.</div></main>`);
        const context = collectReplyContext(doc, 'github');
        expect(context).toBe('原帖：' + 'O'.repeat(4000) + '\n\n当前讨论：Latest question?\n\nNewest clarification.');
        const latest = doc.querySelectorAll('.js-comment-body')[2];
        latest.textContent = 'N'.repeat(11999);
        const prefix = '原帖：' + 'O'.repeat(4000) + '\n\n当前讨论：';
        expect(collectReplyContext(doc, 'github')).toBe(prefix + 'N'.repeat(12000 - prefix.length));
        latest.textContent = 'N'.repeat(12000);
        expect(collectReplyContext(doc, 'github')).toBe(prefix + 'N'.repeat(12000 - prefix.length));
    });
});
