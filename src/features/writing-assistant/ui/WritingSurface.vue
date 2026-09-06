<!--
 * @file src/features/writing-assistant/ui/WritingSurface.vue
 * 文件职责：在 Gmail 与 GitHub 原生回复操作区自动挂载写作入口，维护当前编辑器的写作会话。
 * 主要内容：一个开关控制入口，依据真实站点编辑器和提交按钮定位；首次点击绑定草稿与会话，重开保持结果。
 * 模块边界：只拥有网页 DOM 和编辑器快照，不注册写作快捷键或网站停用名单，不执行模型和自动发送操作。
 -->
<template>
  <WritingPanel :active="opened" :anchor="anchor" :initial-draft="draft" :initial-context="context" :initial-intent="intent" :session-key="sessionKey" :apply-draft="canInsert ? fillDraft : undefined" @close="close" />
</template>
<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue';
import browser from 'webextension-polyfill';
import {config as initialConfig, subscribeConfig} from '@/src/services/config/store';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {translateLegacyText, normalizeUiLanguage} from '@/src/core/i18n';
import {isWritingPage, type WritingIntent} from '@/src/core/config/writing';
import {applyWritingDraft, captureEditor, collectReplyContext, editorText, findReplyEditors, findReplyActionAnchor, writingSite, type EditorSnapshot} from '../editors';
import WritingPanel from './WritingPanel.vue';
const config = shallowRef(initialConfig);
const unsubscribeConfig = subscribeConfig(value => { config.value = value; });
onBeforeUnmount(unsubscribeConfig);
const iconUrl = browser.runtime.getURL('/icon/128.png');
const opened = ref(false); const draft = ref(''); const context = ref(''); const intent = ref<WritingIntent>('reply'); const sessionKey = ref(0);
const anchor = shallowRef<HTMLElement>(); const snapshot = shallowRef<EditorSnapshot>();
const canInsert = computed(() => Boolean(snapshot.value && !snapshot.value.element.querySelector('a, img, video, audio, table, [contenteditable="false"]')));
const entries = new Map<HTMLElement, {host: HTMLElement; button: HTMLButtonElement; abort: AbortController}>();
const abort = new AbortController(); let observer: MutationObserver; let timer: ReturnType<typeof setTimeout> | undefined;
let currentUrl = location.href;
const dark = computed(() => config.value.theme === 'dark' || (config.value.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
const allowed = () => config.value.on && config.value.writing.enabled && isWritingPage(location.href) && !isExtensionDisabledOnSite(location.href, config.value.disabledExtensionDomains);
function close(restoreFocus = true) { const wasOpened = opened.value; opened.value = false; if (wasOpened && restoreFocus && snapshot.value?.element.isConnected) snapshot.value.element.focus({preventScroll: true}); }
function clearEntries() { for (const entry of entries.values()) { entry.abort.abort(); entry.host.remove(); } entries.clear(); }
function scan() {
  clearTimeout(timer); timer = undefined;
  if (currentUrl !== location.href) { currentUrl = location.href; close(false); snapshot.value = undefined; sessionKey.value++; }
  if (!allowed()) { close(false); snapshot.value = undefined; clearEntries(); return; }
  const site = writingSite(location.href);
  const editors = findReplyEditors(document, site).filter(element => {
    const rect = element.getBoundingClientRect();
    return element.isConnected && rect.width >= 120 && rect.height >= 20 && getComputedStyle(element).visibility !== 'hidden' && Boolean(findReplyActionAnchor(element, site));
  });
  for (const [editor, entry] of entries) if (!editors.includes(editor) || !entry.host.isConnected) { entry.abort.abort(); entry.host.remove(); entries.delete(editor); }
  if (opened.value && (!snapshot.value?.element.isConnected || !entries.has(snapshot.value.element))) close(false);
  for (const editor of editors) {
    const action = findReplyActionAnchor(editor, site)!;
    let entry = entries.get(editor);
    if (!entry) {
      const host = document.createElement('span'); host.setAttribute('data-fluent-read-ui', 'writing-entry');
      host.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;margin-inline:6px;flex-shrink:0;';
      const root = host.attachShadow({mode: 'open'}); const entryAbort = new AbortController();
      const style = document.createElement('style');
      style.textContent = ':host{color-scheme:light}button{display:inline-flex;align-items:center;gap:6px;height:32px;box-sizing:border-box;padding:5px 10px;border:1px solid #d8dee4;border-radius:6px;background:#f6f8fa;color:#38414d;font:500 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;margin:0}img{width:18px;height:18px;object-fit:contain}button:hover{background:#fff1f6;border-color:#ef9fb7}button:focus-visible{outline:2px solid #ef4776;outline-offset:2px}:host([data-theme=dark]) button{background:#292c35;border-color:#454951;color:#e5e7ec}';
      const button = document.createElement('button'); button.type = 'button';
      const icon = document.createElement('img'); icon.alt = ''; icon.src = iconUrl; button.append(icon, document.createElement('span'));
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(editor); }, {signal: entryAbort.signal});
      root.append(style, button); entry = {host, button, abort: entryAbort}; entries.set(editor, entry);
    }
    if (site === 'github' && action.previousElementSibling !== entry.host) action.before(entry.host);
    if (site === 'gmail' && action.nextElementSibling !== entry.host) action.after(entry.host);
    entry.host.dataset.theme = dark.value ? 'dark' : 'light';
    const label = translateLegacyText('写作助手', normalizeUiLanguage(config.value.uiLanguage));
    const node = entry.button.querySelector('span')!; if (node.textContent !== label) node.textContent = label;
    entry.button.setAttribute('aria-label', label);
    entry.button.title = translateLegacyText('起草回复或完善已有草稿', normalizeUiLanguage(config.value.uiLanguage));
  }
}
function schedule() { if (timer === undefined) timer = setTimeout(scan, 80); }
function open(element: HTMLElement) {
  if (!allowed()) return;
  anchor.value = entries.get(element)?.host;
  const next = captureEditor(element, location.href);
  if (snapshot.value?.element !== element || snapshot.value.signature !== next.signature || snapshot.value.url !== next.url) {
    snapshot.value = next; draft.value = editorText(element).slice(0, 12000);
    context.value = collectReplyContext(document, writingSite(location.href), element);
    intent.value = draft.value.trim() ? 'polish' : context.value.trim() ? 'reply' : 'draft'; sessionKey.value++;
  }
  opened.value = true;
}
function fillDraft(text: string): string | undefined {
  if (!allowed() || !snapshot.value) return '当前页面已禁用写作助手。';
  const failure = applyWritingDraft(snapshot.value, text, location.href);
  if (!failure) { snapshot.value = captureEditor(snapshot.value.element, location.href); close(); }
  return failure;
}
watch(() => JSON.stringify([config.value.on, config.value.writing.enabled, config.value.disabledExtensionDomains, config.value.uiLanguage, dark.value]), scan);
onMounted(() => {
  scan(); observer = new MutationObserver(schedule); observer.observe(document.body, {subtree: true, childList: true});
  document.addEventListener('scroll', schedule, {capture: true, passive: true, signal: abort.signal});
  document.addEventListener('focusin', schedule, {signal: abort.signal});
  document.addEventListener('fluentread-route-change', scan, {signal: abort.signal});
  window.addEventListener('resize', schedule, {signal: abort.signal});
  window.addEventListener('hashchange', scan, {signal: abort.signal});
  window.addEventListener('pagehide', () => close(false), {signal: abort.signal});
});
onBeforeUnmount(() => { abort.abort(); observer?.disconnect(); clearTimeout(timer); clearEntries(); });
</script>
