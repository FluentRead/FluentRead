import {describe, expect, it} from 'vitest';
import {parseHTML} from 'linkedom';
import {collectReplyContext, findReplyActionAnchor, findReplyEditors, isWritingEditor} from '@/src/features/writing-assistant/editors';

function page(html: string) {
    const doc = parseHTML(`<html><body>${html}</body></html>`).document;
    doc.querySelectorAll<HTMLElement>('*').forEach(element => { element.getClientRects = () => [{}] as never; });
    return doc;
}

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
        expect(collectReplyContext(doc, 'github', editor)).toBe('Source issue.');
        expect(doc.body.innerHTML).toBe(originalHtml);
    });

    it('limits PR replies to the containing review thread for current and legacy thread wrappers', () => {
        for (const marker of ['data-testid="review-thread"', 'class="js-resolvable-timeline-thread-container"', 'class="js-inline-comments-container"']) {
            const doc = page(`<main><div class="js-comment-body">Unrelated issue summary</div>
              <div ${marker}><div class="js-comment-body">Selected review thread</div>
                <form class="js-inline-comment-form"><textarea name="comment[body]"></textarea></form></div>
              <div data-testid="review-thread"><div class="js-comment-body">Another review thread</div></div>
            </main>`);
            expect(collectReplyContext(doc, 'github', findReplyEditors(doc, 'github')[0])).toBe('Selected review thread');
        }
    });

    it('keeps original source text across bilingual translation, single-slot translation, and restore', () => {
        const doc = page('<main><div class="js-comment-body">Original comment</div></main>');
        const body = doc.querySelector('.js-comment-body')!;
        expect(collectReplyContext(doc, 'github')).toBe('Original comment');
        body.innerHTML = 'Original comment<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">Translated comment</span>';
        expect(collectReplyContext(doc, 'github')).toBe('Original comment');
        body.innerHTML = '<span class="fluent-read-single-slot" data-fr-translation-owned="true" translate="no">Original comment</span>';
        expect(collectReplyContext(doc, 'github')).toBe('Original comment');
        body.textContent = 'Original comment';
        expect(collectReplyContext(doc, 'github')).toBe('Original comment');
    });

    it('uses empty context for a new inline review instead of unrelated page discussion', () => {
        const doc = page('<main><div class="js-comment-body">Other discussion</div><form class="js-inline-comment-form"><textarea name="comment[body]"></textarea></form></main>');
        expect(collectReplyContext(doc, 'github', findReplyEditors(doc, 'github')[0])).toBe('');
    });

    it('separates visible Gmail conversations and leaves a new compose draft without background mail context', () => {
        const doc = page(`<main role="main"><div class="a3s">Selected mail conversation</div><div role="textbox" contenteditable="true"></div>
          <div class="M9"><div role="textbox" contenteditable="true"></div></div></main>
          <main role="main"><div class="a3s">Other mail conversation</div><div role="textbox" contenteditable="true"></div></main>
          <div role="dialog"><div role="textbox" contenteditable="true"></div></div>`);
        const editors = findReplyEditors(doc, 'gmail');
        expect(editors.map(editor => collectReplyContext(doc, 'gmail', editor))).toEqual(['Selected mail conversation', '', 'Other mail conversation', '']);
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
        expect(collectReplyContext(doc, 'github')).toBe(Array.from({length: 12}, (_, index) => `Comment ${index + 2}`).join('\n\n'));
        doc.querySelectorAll<HTMLElement>('.CommentBody').forEach(element => { element.textContent = 'x'.repeat(2000); });
        expect(collectReplyContext(doc, 'github')).toHaveLength(12000);
    });

    it('budgets recent questions before old long comments while counting the separators', () => {
        const doc = page(`<main><div class="js-comment-body">${'O'.repeat(15000)}</div>
          <div class="js-comment-body">Latest question?</div><div class="js-comment-body">Newest clarification.</div></main>`);
        const context = collectReplyContext(doc, 'github');
        expect(context).toHaveLength(12000);
        expect(context.endsWith('\n\nLatest question?\n\nNewest clarification.')).toBe(true);
        const latest = doc.querySelectorAll('.js-comment-body')[2];
        latest.textContent = 'N'.repeat(11999);
        expect(collectReplyContext(doc, 'github')).toBe('N'.repeat(11999));
        latest.textContent = 'N'.repeat(12000);
        expect(collectReplyContext(doc, 'github')).toBe('N'.repeat(12000));
    });
});
