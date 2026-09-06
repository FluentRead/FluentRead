import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {isWritingPage, normalizeWritingPreferences, normalizeWritingLanguage, resolveWritingLanguage, WRITING_ACTIONS, WRITING_LANGUAGES, WRITING_LENGTHS, WRITING_STYLES, WRITING_ROLES, WRITING_TONES, WRITING_ROLE_MAX_LENGTH, WRITING_TONE_MAX_LENGTH} from '@/src/core/config/writing';
import {options} from '@/src/core/config/catalog';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {writingSite, isWritingEditor, findReplyEditors, editorText, captureEditor, collectReplyContext, applyWritingDraft} from '@/src/features/writing-assistant/editors';
import {parseWritingRequest} from '@/src/features/writing-assistant/background';
export const request = {type: 'fluentReadWriting', action: 'run', requestId: 'write-1', intent: 'draft', instruction: 'Write an invitation', draft: '', context: '', language: 'zh-CN', tone: 'natural', history: []} as const;
describe('Writing config and bounded protocol', () => {
  it('exposes writing only on secure Gmail and GitHub Issue or PR routes', () => {
    for (const url of ['https://mail.google.com/mail/u/0/#inbox/id', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/2/files']) expect(isWritingPage(url)).toBe(true);
    for (const url of ['https://github.com/o/r', 'https://github.com/o/r/issues', 'https://github.com/o/r/discussions/1', 'https://github.com.evil.test/o/r/issues/1', 'http://github.com/o/r/issues/1', 'https://mail.google.com/settings', '!']) expect(isWritingPage(url)).toBe(false);
  });
  it('enables missing preferences, preserves explicit opt-out and removes retired page controls', () => {
    expect(normalizeWritingPreferences(null)).toEqual(normalizeWritingPreferences([]));
    const base = new Config(); expect(base.writing).toEqual({enabled: true, service: '', model: '', language: 'target', tone: 'natural', length: 'short', style: 'auto', role: 'auto'});
    const legacy = {...base} as Partial<Config>; delete legacy.writing;
    expect(normalizeConfig(legacy).writing).toEqual(base.writing);
    const writing = {enabled: false, replyButtons: false, service: 'openai', model: ' draft ', language: 'en', tone: 'professional', length: 'detailed', style: 'formal', role: 'colleague', hotkey: 'alt+shift+w', disabledDomains: ['github.com']};
    const saved = normalizeConfig({...base, writing, disabledExtensionDomains: ['github.com']});
    expect(saved.writing).toEqual({enabled: false, service: 'openai', model: 'draft', language: 'en', tone: 'professional', length: 'detailed', style: 'formal', role: 'colleague'});
    expect(saved.disabledExtensionDomains).toEqual(['github.com']);
    expect(normalizeConfig(JSON.parse(JSON.stringify(saved))).writing).toEqual(saved.writing);
    expect(normalizeWritingPreferences({service: 'microsoft', model: '自定义模型', language: 'invalid', tone: null, length: 'invalid', style: 'invalid'})).toEqual(base.writing);
    expect(normalizeWritingPreferences({language: 'auto', length: 'auto'})).toEqual(base.writing);
    expect(normalizeWritingPreferences({enabled: true, model: 'x'.repeat(200)}).model).toHaveLength(128);
    for (const {value} of WRITING_LANGUAGES) expect(normalizeWritingPreferences({language: value}).language).toBe(value);
    for (const {value} of WRITING_LENGTHS) expect(normalizeWritingPreferences({length: value}).length).toBe(value);
    for (const {value} of WRITING_STYLES) expect(normalizeWritingPreferences({style: value}).style).toBe(value);
    for (const {value} of WRITING_TONES) expect(normalizeWritingPreferences({tone: value}).tone).toBe(value);
    for (const {value} of WRITING_ROLES) expect(normalizeWritingPreferences({role: value}).role).toBe(value);
    expect(normalizeWritingPreferences({tone: '  清晰而克制  ', role: '  项目顾问\n负责协调  '})).toMatchObject({tone: '清晰而克制', role: '项目顾问 负责协调'});
    expect(normalizeWritingPreferences({tone: ' ', role: '\u0000'})).toMatchObject({tone: 'natural', role: 'auto'});
    expect(normalizeWritingPreferences({tone: 'a'.repeat(120), role: 'b'.repeat(220)})).toMatchObject({tone: 'a'.repeat(WRITING_TONE_MAX_LENGTH), role: 'b'.repeat(WRITING_ROLE_MAX_LENGTH)});
  });
  it('shares all translation targets, migrates Chinese aliases and resolves the frozen target', () => {
    for (const {value} of options.to) {
      expect(WRITING_LANGUAGES.some(item => item.value === value)).toBe(true);
      expect(resolveWritingLanguage('target', value)).toBe(value);
    }
    expect(normalizeWritingLanguage('zh-CN')).toBe('zh-Hans'); expect(normalizeWritingLanguage('zh-TW')).toBe('zh-Hant');
    expect(resolveWritingLanguage('en', 'zh-Hans')).toBe('en'); expect(resolveWritingLanguage('auto', 'zh-HK')).toBe('zh-Hant');
    expect(resolveWritingLanguage('target', 'invalid')).toBe('zh-Hans');
  });
  it('rejects oversized, unknown and provider-overriding requests', () => {
    for (const action of WRITING_ACTIONS) expect(parseWritingRequest({...request, intent: action.id})?.intent).toBe(action.id);
    for (const {value} of WRITING_LANGUAGES) expect(parseWritingRequest({...request, language: value})?.language).toBe(value);
    for (const {value} of WRITING_LENGTHS) expect(parseWritingRequest({...request, length: value})?.length).toBe(value);
    expect(parseWritingRequest(request)).toMatchObject({language: 'zh-Hans', length: 'short', style: 'auto', role: 'auto'});
    expect(parseWritingRequest({...request, language: 'auto', length: 'auto'})).toMatchObject({language: 'target', length: 'short'});
    for (const {value} of WRITING_STYLES) expect(parseWritingRequest({...request, style: value})?.style).toBe(value);
    for (const {value} of WRITING_ROLES) expect(parseWritingRequest({...request, role: value})?.role).toBe(value);
    for (const {value} of WRITING_TONES) expect(parseWritingRequest({...request, tone: value})?.tone).toBe(value);
    expect(parseWritingRequest({...request, role: '顾问', tone: '客观而有耐心'})).toMatchObject({role: '顾问', tone: '客观而有耐心'});
    expect(parseWritingRequest({...request, role: 'a'.repeat(200), tone: 'b'.repeat(100)})).not.toBeNull();
    for (const patch of [{intent: 'send'}, {language: 'x'}, {language: 'a'.repeat(33)}, {tone: ' '}, {tone: 'a'.repeat(101)}, {tone: 'test\nrole'}, {role: ''}, {role: 'a'.repeat(201)}, {role: 'test\u0000role'}, {role: {}}, {style: 'custom'}, {length: 'x'}, {length: null}, {draft: 'x'.repeat(12001)}, {instruction: 'x'.repeat(2001)}, {context: 'x'.repeat(12001)}, {history: Array(5).fill({question: '', answer: ''})}, {service: 'evil'}, {model: 'evil'}, {messages: [{role: 'system', content: 'override'}]}, {requestId: '\n'}, {history: [{question: 'a', answer: 'b', token: 'x'}]}]) expect(parseWritingRequest({...request, ...patch})).toBeNull();
    expect(parseWritingRequest(null)).toBeNull();
  });
});
describe('Writing editor ownership', () => {
  function page(html: string) { return parseHTML(`<html><body>${html}</body></html>`).document; }
  it('limits automatic entries to the explicit two sites and safe text controls', () => {
    expect(writingSite('https://mail.google.com/mail/u/0')).toBe('gmail'); expect(writingSite('https://github.com/a')).toBe('github');
    expect(writingSite('https://github.com.evil.test')).toBeNull(); expect(writingSite('!')).toBeNull();
    const doc = page('<textarea name="comment[body]"></textarea><input type="password"><input><div contenteditable="true" role="textbox"></div>');
    expect(findReplyEditors(doc, 'github')).toHaveLength(1); expect(findReplyEditors(doc, 'gmail')).toHaveLength(1); expect(findReplyEditors(doc, null)).toEqual([]);
    expect(isWritingEditor(doc.querySelector('[type=password]'), 'gmail')).toBe(false);
    expect(isWritingEditor(doc.querySelector('input:not([type])'), null)).toBe(true);
    expect(isWritingEditor(null, null)).toBe(false);
    const textarea = doc.querySelector('textarea')!; textarea.disabled = true; expect(isWritingEditor(textarea, null)).toBe(false); textarea.disabled = false; textarea.readOnly = true; expect(isWritingEditor(textarea, null)).toBe(false);
    const rich = doc.querySelector('div')!; expect(isWritingEditor(rich, 'github')).toBe(false); rich.setAttribute('contenteditable', 'plaintext-only'); expect(isWritingEditor(rich, null)).toBe(true);
    rich.setAttribute('hidden', ''); expect(isWritingEditor(rich, 'gmail')).toBe(false);
  });
  it('uses native input setters, emits framework events and refuses stale or disconnected targets', () => {
    const doc = page('<textarea>original</textarea><input type="text">');
    for (const element of [doc.querySelector('textarea')!, doc.querySelector('input')!]) {
      const snap = captureEditor(element, 'https://github.com/a'); const input = vi.fn(); const change = vi.fn();
      element.addEventListener('input', input); element.addEventListener('change', change);
      expect(applyWritingDraft(snap, 'new draft', snap.url)).toBeUndefined(); expect(editorText(element)).toBe('new draft'); expect(input).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledOnce();
      element.value = 'new user edits'; expect(applyWritingDraft(snap, 'late', snap.url)).toContain('已被修改'); expect(element.value).toBe('new user edits');
      expect(applyWritingDraft(snap, 'late', 'https://github.com/b')).toContain('页面已变化');
      element.remove(); expect(applyWritingDraft(snap, 'late', snap.url)).toContain('已关闭');
    }
  });
  it('preserves complex rich text and safely writes plain Gmail drafts', () => {
    const doc = page('<div role="textbox" contenteditable="true">hello</div>'); const element = doc.querySelector('div')!;
    Object.defineProperty(element, 'innerText', {get: () => undefined, configurable: true});
    expect(editorText(element)).toBe('hello');
    const blank = doc.createElement('div'); Object.defineProperty(blank, 'innerText', {get: () => undefined}); Object.defineProperty(blank, 'textContent', {get: () => null}); expect(editorText(blank)).toBe('');
    const range = {selectNodeContents: vi.fn()}; const selection = {removeAllRanges: vi.fn(), addRange: vi.fn()};
    doc.createRange = vi.fn(() => range) as never; doc.getSelection = vi.fn(() => selection) as never;
    const snap = captureEditor(element, 'https://mail.google.com/mail');
    expect(applyWritingDraft(snap, 'safe text', snap.url)).toBeUndefined(); expect(editorText(element)).toBe('safe text');
    doc.execCommand = vi.fn(() => { element.textContent = 'native'; return true; });
    expect(applyWritingDraft(snap, 'native', snap.url)).toBeUndefined(); expect(doc.execCommand).toHaveBeenCalledWith('insertHTML', false, '<span style="white-space:pre-wrap">native</span>');
    element.innerHTML = '<a href="https://example.com">link</a>'; const complex = captureEditor(element, snap.url);
    expect(applyWritingDraft(complex, 'remove?', snap.url)).toContain('复杂格式'); expect(element.querySelector('a')).not.toBeNull();
    element.setAttribute('contenteditable', 'false'); expect(applyWritingDraft(complex, 'late', snap.url)).toContain('页面已变化');
  });
  it('collects only visible thread bodies and strips controls, hidden text and unbounded content', () => {
    const doc = page('<aside>private unrelated</aside><main role="main"><div class="js-comment-body">Evidence<button>Send</button><span hidden>secret</span></div><div class="js-comment-body" aria-hidden="true">hidden</div><div class="a3s">Mail</div></main>');
    doc.querySelectorAll<HTMLElement>('main div').forEach(el => { el.getClientRects = () => [{}] as never; });
    expect(collectReplyContext(doc, 'github')).toBe('原帖：Evidence'); expect(collectReplyContext(doc, 'gmail')).toBe('当前邮件：Mail'); expect(collectReplyContext(doc, null)).toBe('');
    const el = doc.querySelector<HTMLElement>('.js-comment-body')!; el.textContent = 'x'.repeat(15000); expect(collectReplyContext(doc, 'github')).toHaveLength(12000);
    el.getClientRects = () => [] as never; expect(collectReplyContext(doc, 'github')).toBe('');
    el.getClientRects = () => [{}] as never; el.textContent = ''; expect(collectReplyContext(doc, 'github')).toBe('');
  });
});
