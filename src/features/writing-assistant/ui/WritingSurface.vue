<!--
 * @file src/features/writing-assistant/ui/WritingSurface.vue
 * 文件职责：管理网页写作入口与面板的本页会话，适配 Gmail 和 GitHub 的动态回复框。
 * 主要内容：在隔离 Shadow DOM 中定位回复按钮，显式打开时快照正文；快捷键、路由、配置与卸载共享清理边界。
 * 模块边界：拥有 DOM 和编辑器快照；通过面板使用生成服务，不自动读取整页或提交表单。
 -->
<template>
  <WritingPanel :active="opened" :anchor="anchor" :initial-draft="draft" :initial-context="context" :initial-intent="intent" :session-key="sessionKey" :apply-draft="snapshot ? fillDraft : undefined" @close="close" />
  <WritingMenu :active="menuOpened" :anchor="anchor" :dark="dark" :busy="saving" :error="menuError" @close="close" @settings="openSettings" @disable="disable" />
</template>
<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue';
import {config as initialConfig, subscribeConfig, requestConfigPatch} from '@/src/services/config/store';
import browser from 'webextension-polyfill';
import {isExtensionDisabledOnSite, getSiteBaseDomain} from '@/src/core/site-rules/domain';
import {matchesHotkey, parseHotkey} from '@/src/core/hotkey';
import {translateLegacyText, normalizeUiLanguage} from '@/src/core/i18n';
import {isWritingPage} from '@/src/core/config/writing';
import type {WritingIntent} from '@/src/core/config/writing';
import {applyWritingDraft, captureEditor, collectReplyContext, editorText, findReplyEditors, isWritingEditor, writingSite, type EditorSnapshot} from '../editors';
import WritingPanel from './WritingPanel.vue';
import WritingMenu from './WritingMenu.vue';
const iconUrl = browser.runtime.getURL('/icon/128.png');
const config = shallowRef(initialConfig);
const unsubscribeConfig = subscribeConfig(value => { config.value = value; });
onBeforeUnmount(unsubscribeConfig);
const opened = ref(false); const draft = ref(''); const context = ref(''); const intent = ref<WritingIntent>('draft'); const sessionKey = ref(0);
const anchor = shallowRef<HTMLElement>();
const menuOpened = ref(false); const saving = ref(false); const menuError = ref('');
const dark = computed(() => config.value.theme === 'dark' || (config.value.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
let dismissed = false;
const snapshot = shallowRef<EditorSnapshot>();
const buttons = shallowRef<Array<{element: HTMLElement}>>([]);
const entries = new Map<HTMLElement, {host: HTMLElement; button: HTMLButtonElement; menuButton: HTMLButtonElement; abort: AbortController}>();
const abort = new AbortController();
let observer: MutationObserver; let timer: ReturnType<typeof setTimeout> | undefined;
let returnFocus: HTMLElement | null = null;
let currentUrl = location.href;
const allowed = () => !dismissed && config.value.on && config.value.writing.enabled && isWritingPage(location.href) && !isExtensionDisabledOnSite(location.href, [...config.value.writing.disabledDomains, ...config.value.disabledExtensionDomains]);
function scan() {
  timer = undefined;
  if (currentUrl !== location.href) { currentUrl = location.href; dismissed = false; close(); snapshot.value = undefined; }
  if (!allowed()) { close(); buttons.value = []; for (const entry of entries.values()) { entry.abort.abort(); entry.host.remove(); } entries.clear(); return; }
  if ((opened.value || menuOpened.value) && (!anchor.value?.isConnected || (snapshot.value && !snapshot.value.element.isConnected))) close();
  const editors = config.value.writing.replyButtons ? findReplyEditors(document, writingSite(location.href)).filter(element => {
    const rect = element.getBoundingClientRect();
    return element.isConnected && rect.width >= 120 && rect.height >= 20 && getComputedStyle(element).visibility !== 'hidden';
  }) : [];
  buttons.value = editors.map(element => ({element}));
  for (const [editor, entry] of entries) {
    if (!editors.includes(editor) || !entry.host.isConnected) { entry.abort.abort(); entry.host.remove(); entries.delete(editor); }
  }
  for (const editor of editors) {
    let entry = entries.get(editor);
    if (!entry) {
      const host = document.createElement('span'); host.setAttribute('data-fluent-read-ui', 'writing-entry');
      host.style.cssText = 'display:inline-flex;vertical-align:middle;margin-inline-start:8px;flex-shrink:0;';
      const root = host.attachShadow({mode: 'open'});
      const style = document.createElement('style');
      style.textContent = ':host{color-scheme:light;display:inline-flex}button{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid #d8dee4;border-radius:7px 0 0 7px;background:#f6f8fa;color:#38414d;font:500 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;margin:0}button>img{width:19px;height:19px;object-fit:contain}button.more{border-radius:0 7px 7px 0;border-left:0;padding:4px 7px;font-size:19px;line-height:1}button:hover{background:#fff1f6;border-color:#ef9fb7}button:focus-visible{outline:2px solid #ef4776;outline-offset:2px}:host([data-theme=dark]) button{background:#292c35;border-color:#454951;color:#e5e7ec}:host([data-theme=dark]) button:hover{background:#372b35}';
      const entryAbort = new AbortController();
      const button = document.createElement('button'); button.type = 'button';
      const icon = document.createElement('img'); icon.alt = ''; icon.src = iconUrl; button.append(icon, document.createElement('span'));
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(editor); }, {signal: entryAbort.signal});
      const menuButton = document.createElement('button'); menuButton.type = 'button'; menuButton.className = 'more'; menuButton.textContent = '⋮';
      menuButton.setAttribute('aria-haspopup', 'dialog');
      menuButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); const show = !menuOpened.value || anchor.value !== host; close(); snapshot.value = undefined; anchor.value = host; returnFocus = menuButton; menuOpened.value = show; menuError.value = ''; }, {signal: entryAbort.signal});
      root.append(style, button, menuButton);
      const scope = editor.closest('form, [role="dialog"], .M9, [data-testid="comment-box"], .js-inline-comment-form') ?? editor.parentElement!;
      const send = scope.querySelector('[data-testid="comment-button"], .js-comment-and-button') ?? scope.querySelector('[role="button"][data-tooltip*="Enter"], button[type="submit"]');
      if (send?.parentElement && !send.closest('[data-fluent-read-ui]')) send.insertAdjacentElement('afterend', host);
      else editor.insertAdjacentElement('afterend', host);
      entry = {host, button, menuButton, abort: entryAbort}; entries.set(editor, entry);
    }
    entry.host.dataset.theme = dark.value ? 'dark' : 'light';
    entry.menuButton.setAttribute('aria-label', translateLegacyText('写作助手选项', normalizeUiLanguage(config.value.uiLanguage)));
    entry.menuButton.setAttribute('aria-expanded', String(menuOpened.value && anchor.value === entry.host));
    const label = translateLegacyText('写作助手', normalizeUiLanguage(config.value.uiLanguage));
    const labelNode = entry.button.querySelector('span')!; if (labelNode.textContent !== label) labelNode.textContent = label; entry.button.setAttribute('aria-label', label);
  }
}
function schedule() { if (timer === undefined) timer = setTimeout(scan, 80); }
function close() { opened.value = false; menuOpened.value = false; if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true}); returnFocus = null; }
function open(element: HTMLElement) {
  if (!allowed()) return;
  menuOpened.value = false; anchor.value = entries.get(element)?.host ?? element;
  returnFocus = element;
  snapshot.value = captureEditor(element, location.href); draft.value = editorText(element).slice(0, 12000);
  context.value = collectReplyContext(document, writingSite(location.href)); intent.value = 'reply'; sessionKey.value++;
  opened.value = true;
}
function fillDraft(text: string): string | undefined {
  if (!allowed() || !snapshot.value) return '当前页面已禁用写作助手。';
  const failure = applyWritingDraft(snapshot.value, text, location.href);
  if (!failure) snapshot.value = captureEditor(snapshot.value.element, location.href);
  return failure;
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat || !allowed() || !config.value.writing.hotkey || event.composedPath().some(node => node instanceof HTMLElement && node.hasAttribute('data-fluent-read-ui'))) return;
  if (!matchesHotkey(event, parseHotkey(config.value.writing.hotkey))) return;
  const active = document.activeElement;
  const target = isWritingEditor(active, writingSite(location.href)) ? active : buttons.value[0]?.element;
  if (!opened.value && !target) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (opened.value) close(); else if (target) open(target);
}
watch(() => JSON.stringify([config.value.on, config.value.writing, config.value.disabledExtensionDomains, config.value.uiLanguage, dark.value]), scan);
async function openSettings() {
  try { await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-writing'}); close(); }
  catch { menuError.value = '请从扩展菜单打开完整设置。'; }
}
async function disable(scope: 'visit' | 'site' | 'all') {
  if (saving.value) return;
  if (scope === 'visit') { dismissed = true; scan(); return; }
  saving.value = true; menuError.value = '';
  try {
    const writing = {...config.value.writing};
    if (scope === 'all') writing.enabled = false;
    else { const domain = getSiteBaseDomain(location.href)!; writing.disabledDomains = [...new Set([...writing.disabledDomains, domain])]; }
    await requestConfigPatch({writing}, browser.runtime.sendMessage.bind(browser.runtime)); close();
  } catch { menuError.value = '保存失败，请重试。'; }
  finally { saving.value = false; }
}
watch(menuOpened, scan);
onMounted(() => {
  scan(); observer = new MutationObserver(schedule); observer.observe(document.body, {subtree: true, childList: true});
  document.addEventListener('pointerdown', event => { if (menuOpened.value && !event.composedPath().some(node => node instanceof HTMLElement && (node.id === 'fluent-read-writing-assistant' || node.hasAttribute('data-fluent-read-ui')))) close(); }, {signal: abort.signal});
  document.addEventListener('keydown', keydown, {capture: true, signal: abort.signal});
  document.addEventListener('scroll', schedule, {capture: true, passive: true, signal: abort.signal});
  document.addEventListener('focusin', schedule, {signal: abort.signal});
  document.addEventListener('fluentread-route-change', scan, {signal: abort.signal});
  window.addEventListener('resize', schedule, {signal: abort.signal});
  window.addEventListener('hashchange', scan, {signal: abort.signal});
  window.addEventListener('pagehide', close, {signal: abort.signal});
});
onBeforeUnmount(() => { abort.abort(); observer?.disconnect(); clearTimeout(timer); for (const entry of entries.values()) { entry.abort.abort(); entry.host.remove(); } entries.clear(); });
</script>
