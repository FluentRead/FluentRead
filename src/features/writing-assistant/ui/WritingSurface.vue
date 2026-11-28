<!--
 * @file src/features/writing-assistant/ui/WritingSurface.vue
 * 文件职责：在隔离层中为一等写作网站定位原生入口，并承接全网页快捷键按需呼出的写作会话。
 * 主要内容：在一等协作网站原生操作行内隔离写作按钮与三点设置入口，非一等网站不主动注入浮动按钮而是通过快捷键聚焦编辑框按需打开；点击面板外仅收起并保留当前会话，管理本次关闭、网站禁用和永久关闭，观察整页 body 替换、入口被网页移除和编辑器更新，卸载后拒绝迟到保存与观察回调重建入口。
 * 模块边界：只拥有网页 DOM、编辑器快照与入口交互；配置持久化交由共享服务，不执行模型和自动发送操作。
 -->
<template>
  <WritingPanel ref="panel" :active="opened" :anchor="anchor" :initial-draft="draft" :initial-context="context" :initial-intent="intent" :session-key="sessionKey" :plain-text-output="plainTextOutput" :apply-draft="canInsert ? fillDraft : undefined" @close="close" />
  <WritingEntrySettings :active="menuOpened" :anchor="menuAnchor" :dark="dark" :saving="saving" :error="menuError" :hotkey="hotkeyDisplay" @close="closeMenu" @save="saveEntrySetting" @settings="openSettings" />
</template>
<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue';
import browser from 'webextension-polyfill';
import {config as initialConfig, subscribeConfig, requestConfigPatch} from '@/src/services/config/store';
import {getSiteBaseDomain, isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {useUiI18n} from '@/src/ui/i18n';
import {isWritingEligibleUrl, isWritingPage, writingHotkeyDisplayName, type WritingIntent} from '@/src/core/config/writing';
import {
  applyWritingDraft, captureEditor, collectReplyContext, editorText, findReplyEditors, findReplyActionAnchor,
  hasComplexRichEditorStructure, isPlainTextWritingSite, isWritingEditor, resolveInitialWritingIntent,
  resolveWritingSite, writingSite, type EditorSnapshot,
} from '../editors';
import {placeWritingEntry, prepareWritingEntryHost} from '../entryPlacement';
import WritingPanel from './WritingPanel.vue';
import WritingEntrySettings from './WritingEntrySettings.vue';
import {dismissWritingForVisit, isWritingDismissedForVisit, writingEntrySaveFailure} from '../entrySession';
import {registerWritingOpenHandler} from '../shortcutRuntime';
const config = shallowRef(initialConfig);
const {t, translateLegacy, language: uiLanguage, bundleRevision} = useUiI18n();
const unsubscribeConfig = subscribeConfig(value => { config.value = value; });
onBeforeUnmount(unsubscribeConfig);
const iconUrl = browser.runtime.getURL('/icon/128.png');
const opened = ref(false); const draft = ref(''); const context = ref(''); const intent = ref<WritingIntent>('reply'); const sessionKey = ref(0);
const panel = shallowRef<InstanceType<typeof WritingPanel>>();
const anchor = shallowRef<HTMLElement>(); const snapshot = shallowRef<EditorSnapshot>();
const canInsert = computed(() => Boolean(snapshot.value && !hasComplexRichEditorStructure(snapshot.value.element)));
const plainTextOutput = computed(() => isPlainTextWritingSite(snapshot.value?.site));
const hotkeyDisplay = computed(() => writingHotkeyDisplayName(config.value.writing.writingHotkey));
const menuOpened = ref(false); const menuAnchor = shallowRef<HTMLElement>(); const saving = ref(false); const menuError = ref('');
type Entry = {host: HTMLElement; button: HTMLButtonElement; menu: HTMLButtonElement; action: HTMLElement; abort: AbortController};
const entries = new Map<HTMLElement, Entry>();
const abort = new AbortController(); let observer: MutationObserver; let timer: ReturnType<typeof setTimeout> | undefined;
let currentUrl = location.href;
let disposed = false;
const dark = computed(() => config.value.theme === 'dark' || (config.value.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
const pageAllowed = () => config.value.on && config.value.writing.enabled && isWritingEligibleUrl(location.href) && !isExtensionDisabledOnSite(location.href, [...config.value.disabledExtensionDomains, ...config.value.writing.disabledDomains]);
const allowed = () => !isWritingDismissedForVisit() && pageAllowed() && isWritingPage(location.href);
function closeMenu(restoreFocus = true) { const wasOpened = menuOpened.value; menuOpened.value = false; if (wasOpened && restoreFocus) menuAnchor.value?.shadowRoot?.querySelector<HTMLButtonElement>('[data-writing-entry-menu]')?.focus({preventScroll: true}); }
function openMenu(host: HTMLElement) { const same = menuOpened.value && menuAnchor.value === host; close(false); closeMenu(false); if (same) return; menuAnchor.value = host; menuError.value = ''; menuOpened.value = true; }
async function saveEntrySetting(scope: 'visit' | 'site' | 'forever') {
  if (saving.value) return;
  if (scope === 'visit') { dismissWritingForVisit(); close(false); closeMenu(false); scan(); return; }
  saving.value = true; menuError.value = '';
  try {
    const domain = getSiteBaseDomain(location.href);
    if (scope === 'site' && !domain) throw new Error('site');
    await requestConfigPatch({writing: {...config.value.writing, ...(scope === 'forever' ? {enabled: false} : {disabledDomains: [...new Set([...config.value.writing.disabledDomains, domain!])]})}}, message => browser.runtime.sendMessage(message));
    close(false); closeMenu(false);
  } catch { writingEntrySaveFailure.value = true; menuError.value = t('writing.entry.saveError'); }
  finally { saving.value = false; scan(); }
}
async function openSettings() {
  try { await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-writing'}); closeMenu(); }
  catch { menuError.value = t('writing.entry.openError'); }
}
function close(restoreFocus = true) { const wasOpened = opened.value; opened.value = false; if (wasOpened && restoreFocus && snapshot.value?.element.isConnected) snapshot.value.element.focus({preventScroll: true}); }
function clearEntries() { for (const entry of entries.values()) { entry.abort.abort(); entry.host.remove(); } entries.clear(); }
function ownUi(node: Node): boolean {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return Boolean(element?.closest('[data-fluent-read-ui]'));
}
function visible(element: HTMLElement): boolean {
  if (!element.isConnected || !element.getClientRects().length || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
}
function scan() {
  clearTimeout(timer); timer = undefined;
  if (disposed) return;
  if (currentUrl !== location.href) { currentUrl = location.href; close(false); closeMenu(false); snapshot.value = undefined; sessionKey.value++; }
  if (!pageAllowed()) { close(false); snapshot.value = undefined; if (!saving.value) { closeMenu(false); clearEntries(); } return; }
  if (!allowed()) {
    closeMenu(false); clearEntries();
    if (opened.value && (!snapshot.value?.element.isConnected || !isWritingEditor(snapshot.value.element, snapshot.value.site))) close(false);
    return;
  }
  // allowed 已验证一等写作网站路由；同步扫描期间站点身份不会改变。
  const site = writingSite(location.href)!;
  const editors = findReplyEditors(document, site, location.href).filter(element => {
    const rect = element.getBoundingClientRect();
    return visible(element) && rect.width >= 120 && rect.height >= 20 && Boolean(findReplyActionAnchor(element, site));
  });
  for (const [editor, entry] of entries) if (!editors.includes(editor) || !entry.host.isConnected) { entry.abort.abort(); entry.host.remove(); entries.delete(editor); }
  if (opened.value && (!snapshot.value?.element.isConnected || (!entries.has(snapshot.value.element) && anchor.value !== snapshot.value.element))) close(false);
  if (menuOpened.value && ![...entries.values()].some(entry => entry.host === menuAnchor.value)) closeMenu(false);
  for (const editor of editors) {
    const action = findReplyActionAnchor(editor, site)!;
    let entry = entries.get(editor);
    if (!entry) {
      const host = document.createElement('span'); host.setAttribute('data-fluent-read-ui', 'writing-entry');
      prepareWritingEntryHost(host);
      const root = host.attachShadow({mode: 'open'}); const entryAbort = new AbortController();
      const style = document.createElement('style');
      style.textContent = ':host{color-scheme:light}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;box-sizing:border-box;padding:5px 10px;border:1px solid #d8dee4;border-radius:6px;background:#f6f8fa;color:#38414d;font:500 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;margin:0}img{width:18px;height:18px;object-fit:contain}button:hover{background:#fff1f6;border-color:#ef9fb7}button:focus-visible{outline:2px solid #ef4776;outline-offset:2px}:host([data-compact]) button{width:32px;padding:6px}:host([data-compact]) span{display:none}:host([data-theme=dark]) button{background:#292c35;border-color:#454951;color:#e5e7ec}';
      style.textContent += 'button:first-of-type{border-radius:6px 0 0 6px}button[data-writing-entry-menu]{width:26px;padding:0;border-left:0;border-radius:0 6px 6px 0;font-size:19px;font-weight:600;line-height:1}';
      const button = document.createElement('button'); button.type = 'button';
      const icon = document.createElement('img'); icon.alt = ''; icon.src = iconUrl; button.append(icon, document.createElement('span'));
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(editor); }, {signal: entryAbort.signal});
      const menu = document.createElement('button'); menu.type = 'button'; menu.textContent = '⋮'; menu.setAttribute('data-writing-entry-menu', ''); menu.setAttribute('aria-haspopup', 'dialog');
      menu.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openMenu(host); }, {signal: entryAbort.signal});
      root.append(style, button, menu); entry = {host, button, menu, action, abort: entryAbort}; entries.set(editor, entry);
    }
    entry.action = action;
    placeWritingEntry(entry.action, entry.host, site as Exclude<typeof site, 'generic'>);
    entry.host.dataset.theme = dark.value ? 'dark' : 'light';
    const label = translateLegacy('写作助手');
    const node = entry.button.querySelector('span')!; if (node.textContent !== label) node.textContent = label;
    entry.button.setAttribute('aria-label', label);
    entry.button.title = translateLegacy('起草回复或完善已有草稿');
    entry.button.setAttribute('aria-haspopup', 'dialog');
    entry.button.setAttribute('aria-expanded', String(opened.value && snapshot.value?.element === editor));
    const menuLabel = t('writing.entry.trigger'); entry.menu.title = menuLabel; entry.menu.setAttribute('aria-label', menuLabel);
    entry.menu.setAttribute('aria-expanded', String(menuOpened.value && menuAnchor.value === entry.host));
  }
  if (writingEntrySaveFailure.value && entries.size && !saving.value) { openMenu(entries.values().next().value!.host); menuError.value = t('writing.entry.saveError'); writingEntrySaveFailure.value = false; }
}
function schedule() { if (!disposed && timer === undefined) timer = setTimeout(scan, 80); }
function open(element: HTMLElement, fromShortcut = false) {
  const entry = entries.get(element);
  const site = fromShortcut ? resolveWritingSite(location.href) : writingSite(location.href);
  if (fromShortcut) {
    if (!pageAllowed() || !isWritingEditor(element, site) || !visible(element)) return;
    anchor.value = entry?.host.isConnected && visible(entry.action) ? entry.host : element;
  } else {
    if (!allowed() || !isWritingEditor(element, site) || !visible(element) || !entry?.host.isConnected || !visible(entry.action)) return;
    anchor.value = entry.host;
  }
  closeMenu(false);
  const next = captureEditor(element, location.href, site);
  if (snapshot.value?.element !== element || snapshot.value.signature !== next.signature || snapshot.value.url !== next.url) {
    snapshot.value = next; draft.value = editorText(element).slice(0, 12000);
    context.value = collectReplyContext(document, site, element, location.href);
    intent.value = resolveInitialWritingIntent(next.site, next.url, draft.value, context.value); sessionKey.value++;
  }
  opened.value = true;
}
function fillDraft(text: string): string | undefined {
  if (!pageAllowed() || !snapshot.value) return '当前页面已禁用写作助手。';
  const failure = applyWritingDraft(snapshot.value, text, location.href);
  if (!failure) { snapshot.value = captureEditor(snapshot.value.element, location.href, snapshot.value.site); close(); }
  return failure;
}
watch(() => JSON.stringify([config.value.on, config.value.writing.enabled, config.value.writing.disabledDomains, config.value.disabledExtensionDomains, uiLanguage.value, bundleRevision.value, dark.value]), scan);
watch(menuOpened, () => { for (const entry of entries.values()) entry.menu.setAttribute('aria-expanded', String(menuOpened.value && menuAnchor.value === entry.host)); });
watch(writingEntrySaveFailure, scan);
watch(opened, () => { for (const [editor, entry] of entries) entry.button.setAttribute('aria-expanded', String(opened.value && snapshot.value?.element === editor)); });
onMounted(() => {
  scan();
  registerWritingOpenHandler(element => open(element, true));
  observer = new MutationObserver(records => {
    // 网页框架可只移除扩展入口；跳过自身 UI 更新时仍须恢复已脱离文档的入口。
    const entryRemoved = records.some(record => record.type === 'childList' && record.removedNodes.length > 0)
      && [...entries.values()].some(entry => !entry.host.isConnected);
    if (entryRemoved || records.some(record => !ownUi(record.target) && (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !ownUi(node))))) schedule();
  });
  observer.observe(document, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'aria-disabled', 'disabled', 'readonly', 'contenteditable', 'inert']});
  document.addEventListener('focusin', schedule, {signal: abort.signal});
  document.addEventListener('pointerdown', event => {
    const path = event.composedPath();
    const panelRoot = panel.value?.$el;
    // Shadow DOM 会重定向 event.target；沿真实事件路径保留卡片内部控件和当前入口的操作。
    // 仅收起已有实例，不夺回焦点，也不重建会话，用户可继续点击宿主页面。
    if (opened.value && !path.includes(anchor.value!) && (!panelRoot || !path.includes(panelRoot))) close(false);
    if (menuOpened.value && !saving.value && !path.includes(menuAnchor.value!) && !path.some(node => node instanceof Element && node.classList.contains('writing-entry-settings'))) closeMenu(false);
  }, {capture: true, signal: abort.signal});
  document.addEventListener('fluentread-route-change', scan, {signal: abort.signal});
  window.addEventListener('resize', schedule, {signal: abort.signal});
  window.visualViewport?.addEventListener('resize', schedule, {signal: abort.signal});
  document.addEventListener('transitionend', schedule, {capture: true, signal: abort.signal});
  window.addEventListener('hashchange', scan, {signal: abort.signal});
  window.addEventListener('pagehide', () => { close(false); closeMenu(false); }, {signal: abort.signal});
});
onBeforeUnmount(() => { disposed = true; registerWritingOpenHandler(null); abort.abort(); observer?.disconnect(); clearTimeout(timer); clearEntries(); });
</script>
