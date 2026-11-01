<!--
 * @file src/features/image-translation/ui/MangaReadingPanel.vue
 * 文件职责：提供用户主动打开的漫画可见目标选择和文字阅读面板。
 * 主要内容：按目标显示完整文字和原文对照，以有界分页提供选择和复制，区分等待、过期及预算状态，关闭或失效时撤销在途读取。
 * 模块边界：由漫画入口管理挂载与生命周期，仅使用注入的只读候选、读取、复制及本地化端口，不扫描页面、不执行 OCR、不访问网络或保存结果。
 -->
<template>
  <section v-if="opened" ref="panel" class="fr-manga-reading" :data-theme="theme" role="dialog" :aria-label="t('漫画文字')" tabindex="-1" @keydown.stop="handleKeydown" @click.stop @pointerdown.stop @touchstart.passive.stop @touchmove.passive.stop @touchend.passive.stop @touchcancel.passive.stop @keyup.stop @wheel.stop>
    <header>
      <strong>{{ t('漫画文字') }}</strong>
      <button type="button" :aria-label="t('关闭文字面板')" @click="close">×</button>
    </header>
    <div v-if="!selected" class="fr-manga-reading-body">
      <p>{{ t('选择当前可见的页面或片段') }}</p>
      <div v-if="items.length" class="fr-manga-reading-list">
        <button v-for="(item, index) in items" :key="index" ref="candidateButtons" type="button" @click="select(item, $event)">{{ label(item) }}</button>
      </div>
      <p v-if="status" role="status">{{ message(status) }}</p>
      <button v-if="status === 'stale' || status === 'unavailable' || status === 'noCandidates' || status === 'overBudget' || status === 'error'" ref="refreshButton" type="button" @click="refreshFromButton($event)">{{ t('重新查看可见页面') }}</button>
    </div>
    <template v-else>
      <div class="fr-manga-reading-heading"><button ref="backButton" type="button" @click="back($event)">{{ t('选择其他页面') }}</button><span>{{ label(selected) }}</span></div>
      <p v-if="selected.kind === 'segment'" class="fr-manga-reading-context">{{ t('此片段可能包含相邻片段的文字') }}</p>
      <p v-if="selected.kind === 'canvas'" class="fr-manga-reading-context">{{ t('画布文字来自最近完成的翻译快照，画面变化可能尚未同步') }}</p>
      <div v-if="status !== 'ready'" class="fr-manga-reading-body"><p role="status">{{ message(status) }}</p></div>
      <template v-else>
        <div class="fr-manga-reading-tools">
          <button type="button" :aria-pressed="compare" @click="compare = !compare">{{ t('原文对照') }}</button>
          <span :aria-label="t('文字部分')">{{ pageIndex + 1 }} / {{ pages.length }}</span>
          <button ref="previousButton" type="button" :disabled="pageIndex === 0" @click="changePage(-1, $event)">{{ t('上一部分') }}</button>
          <button ref="nextButton" type="button" :disabled="pageIndex + 1 >= pages.length" @click="changePage(1, $event)">{{ t('下一部分') }}</button>
        </div>
        <div class="fr-manga-reading-body" tabindex="0">
          <article v-for="(line, index) in pages[pageIndex]" :key="index">
            <pre v-if="compare && line.sourceText !== undefined && line.sourceText !== line.text" class="fr-manga-reading-source" dir="auto">{{ line.sourceText }}</pre>
            <pre dir="auto">{{ line.text }}</pre>
            <p v-if="line.numericUncertain" class="fr-manga-reading-context">{{ t('数字识别可能有误，请对照原图') }}</p>
            <p v-if="line.renderSkipped" class="fr-manga-reading-context">{{ t('为保护数字，此译文未绘制到图片') }}</p>
          </article>
        </div>
        <footer><span role="status">{{ feedback || t('本地 OCR · 请核对名称和数字') }}</span><button type="button" @click="copyPage">{{ t('复制当前部分') }}</button><button type="button" @click="copyAll">{{ t('复制全部') }}</button></footer>
      </template>
    </template>
  </section>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue';
import type {MangaReadingCandidate, MangaReadingList, MangaReadingResult} from '../content/mangaReadingCoordinator';
import type {MangaReadingLine} from '../content/mangaReadingSnapshots';
const props = defineProps<{
  list: () => MangaReadingList;
  read: (token: object, signal: AbortSignal) => Promise<MangaReadingResult>;
  observe: (token: object, invalid: () => void) => (() => void) | undefined;
  copy: (text: string) => Promise<void>;
  translate: (text: string) => string;
  theme: 'light' | 'dark' | 'auto';
}>();
const emit = defineEmits<{opened: []; closed: []}>();
const t = (text: string) => props.translate(text);
const opened = ref(false), panel = ref<HTMLElement | null>(null), items = shallowRef<MangaReadingCandidate[]>([]);
const candidateButtons = ref<HTMLButtonElement[]>([]), backButton = ref<HTMLButtonElement | null>(null), refreshButton = ref<HTMLButtonElement | null>(null), previousButton = ref<HTMLButtonElement | null>(null), nextButton = ref<HTMLButtonElement | null>(null);
const selected = shallowRef<MangaReadingCandidate | null>(null), lines = shallowRef<MangaReadingLine[]>([]), pageIndex = ref(0), compare = ref(false), feedback = ref('');
type Status = MangaReadingResult['status'] | 'loading' | 'noCandidates' | '';
const status = ref<Status>('');
let controller: AbortController | null = null, revision = 0, copyRevision = 0, focusRevision = 0, trigger: HTMLElement | null = null, disposed = false, stopObservation: (() => void) | undefined;
const MAX_PAGE_CHARS = 16000, MAX_PAGE_LINES = 32, MAX_LINES = 512, MAX_TOTAL_CHARS = 524288;
watch([compare, pageIndex], () => {copyRevision++;focusRevision++;feedback.value = '';}, {flush:'sync'});
// 按完整识别行分页；超长单行明确拒绝，避免分割文字或误称完整。
const pages = computed(() => {
  const result: MangaReadingLine[][] = []; let page: MangaReadingLine[] = [], chars = 0;
  for (const line of lines.value) {
    const size = line.text.length + (line.sourceText?.length ?? 0);
    if (page.length && (page.length >= MAX_PAGE_LINES || chars + size > MAX_PAGE_CHARS)) {result.push(page);page = [];chars = 0;}
    page.push(line);chars += size;
  }
  if (page.length) result.push(page);
  return result;
});
function label(item: MangaReadingCandidate): string {
  const name = {image:'图片',canvas:'画布',background:'背景图片',segment:'长图片段'}[item.kind];
  const part = item.segment ? ` · ${t('像素位置')} ${item.segment.top}–${item.segment.top + item.segment.height}` : '';
  return `${t(name)} ${item.ordinal}${part}`;
}
function message(value: Status): string {
  const messages: Record<Status, string> = {'':'',ready:'',loading:'正在读取已有文字',pending:'当前页面正在处理',empty:'未检测到文字',error:'无法读取当前结果',unavailable:'当前结果不可用',stale:'页面已变化，请重新选择',cancelled:'读取已取消',overBudget:'内容过大，暂时无法完整显示',noCandidates:'当前没有可查看的页面'};
  return t(messages[value]);
}
function cancel() {revision++;copyRevision++;focusRevision++;controller?.abort();controller = null;stopObservation?.();stopObservation = undefined;feedback.value = '';}
function refresh() {
  if (!opened.value || disposed) return;
  cancel();selected.value = null;lines.value = [];pageIndex.value = 0;
  try {const list = props.list();items.value = list.status === 'ready' ? list.items : [];status.value = list.status === 'ready' ? (list.items.length ? '' : 'noCandidates') : list.status;}
  catch {items.value = [];status.value = 'error';}
}
// 只比较可访问的焦点链；其他组件的 closed shadow root 内部不可观测。
function focusPath(root?: Document | ShadowRoot): Element[] {
  const path: Element[] = [];let focused = root?.activeElement;
  while (focused) {path.push(focused);focused = focused.shadowRoot?.activeElement;}
  return path;
}
function sameFocus(root: Document | ShadowRoot | undefined, previous: Element[]): boolean {
  const current = focusPath(root);
  return current.length === previous.length && current.every((element, index) => element === previous[index]);
}
function mayTakeFocus(from: HTMLElement | null | undefined): boolean {
  const doc = from?.ownerDocument;
  if (!from?.isConnected || !doc) return false;
  const source = from.getRootNode() as Document | ShadowRoot;
  const noFocus = !!doc.activeElement && (doc.activeElement === doc.body || doc.activeElement === doc.documentElement)
    && !doc.activeElement.matches(':focus-within')
    && (source === doc || source.activeElement === null);
  let current: Node = from, ownsFocus = true;
  for (;;) {
    const root = current.getRootNode() as Document | ShadowRoot;
    if (root.activeElement !== current) ownsFocus = false;
    if (root === doc) return ownsFocus || noFocus;
    if (!('host' in root) || !root.host) return false;
    current = root.host;
  }
}
async function open(event: Event, from?: HTMLElement | null) {
  if (!event.isTrusted || disposed) return false;
  const sourceRoot = from?.getRootNode?.() as Document | ShadowRoot | undefined;
  const canFocus = mayTakeFocus(from), sourceFocus = focusPath(sourceRoot), doc = from?.ownerDocument, documentFocus = focusPath(doc);
  cancel();opened.value = true;trigger = from ?? null;refresh();const owner = revision;emit('opened');
  await nextTick();
  if (canFocus && from?.isConnected && from.getRootNode() === sourceRoot && opened.value && owner === revision && sameFocus(sourceRoot, sourceFocus) && sameFocus(doc, documentFocus)) panel.value?.focus({preventScroll:true});
  return true;
}
function close() {
  if (!opened.value) return;
  const root = panel.value?.getRootNode() as Document | ShadowRoot | undefined;
  const active = root?.activeElement;
  const restore = !!panel.value && !!active && panel.value.contains(active);
  cancel();opened.value = false;items.value = [];selected.value = null;lines.value = [];status.value = '';
  const previous = trigger;trigger = null;
  if (restore && previous?.isConnected && !previous.matches(':disabled') && previous.getClientRects().length) previous.focus({preventScroll:true});
  emit('closed');
}
function handleKeydown(event: KeyboardEvent) {if (event.isTrusted && event.key === 'Escape') {event.preventDefault();close();}}
function invalidate() {
  if (!opened.value) return;
  cancel();items.value = [];selected.value = null;lines.value = [];status.value = 'stale';
}
function transferFocus(event: MouseEvent, owner: number, destination: () => HTMLElement | null | undefined) {
  const source = event.currentTarget as HTMLElement | null;
  const root = panel.value?.getRootNode() as Document | ShadowRoot | undefined;
  if (!source || !root || root.activeElement !== source) return;
  const focusOwner = focusRevision;
  void nextTick(() => {
    if (!opened.value || owner !== revision || focusOwner !== focusRevision || !panel.value?.isConnected) return;
    const current = root.activeElement;
    if (current && current !== source && current !== panel.value) return;
    const doc = panel.value.ownerDocument, host = 'host' in root ? root.host : undefined, documentFocus = doc?.activeElement;
    if (documentFocus && documentFocus !== source && documentFocus !== doc.body && documentFocus !== host && documentFocus !== panel.value) return;
    (destination() ?? panel.value).focus({preventScroll:true});
  });
}
function back(event: MouseEvent) {if (!opened.value) return;refresh();transferFocus(event, revision, () => candidateButtons.value[0] ?? refreshButton.value);}
function refreshFromButton(event: MouseEvent) {if (!opened.value) return;refresh();transferFocus(event, revision, () => candidateButtons.value[0] ?? refreshButton.value);}
function changePage(delta: number, event: MouseEvent) {
  const next = pageIndex.value + delta;
  if (!opened.value || status.value !== 'ready' || next < 0 || next >= pages.value.length) return;
  pageIndex.value = next;
  if (delta < 0 && next === 0) transferFocus(event, revision, () => nextButton.value);
  else if (delta > 0 && next + 1 === pages.value.length) transferFocus(event, revision, () => previousButton.value);
}
async function select(item: MangaReadingCandidate, event: MouseEvent) {
  if (!event.isTrusted || !opened.value || !items.value.includes(item)) return;
  cancel();const owner = revision;controller = new AbortController();const signal = controller.signal;
  selected.value = item;lines.value = [];status.value = 'loading';pageIndex.value = 0;compare.value = false;
  transferFocus(event, owner, () => backButton.value);
  try {
    const result = await props.read(item.token, signal);
    if (!opened.value || disposed || owner !== revision || signal.aborted) return;
    if (result.status !== 'ready' && result.status !== 'empty') {status.value = result.status;return;}
    const stop = props.observe(item.token, () => {if (opened.value && owner === revision) close();});
    if (!stop) {status.value = 'stale';return;}
    if (!opened.value || owner !== revision || signal.aborted) {stop();return;}
    stopObservation = stop;
    if (result.status !== 'ready') {status.value = 'empty';return;}
    if (!result.lines.length) {status.value = 'empty';return;}
    let total = 0;
    if (result.lines.length > MAX_LINES || result.lines.some(line => {
      const size = line.text.length + (line.sourceText?.length ?? 0);total += size;
      return size > MAX_PAGE_CHARS || total > MAX_TOTAL_CHARS;
    })) {stopObservation();stopObservation = undefined;status.value = 'overBudget';return;}
    lines.value = result.lines.map(line => ({...line,bbox:{...line.bbox}}));status.value = 'ready';
  } catch {if (opened.value && !disposed && owner === revision && !signal.aborted) status.value = 'error';}
}
function textFor(source: MangaReadingLine[]) {
  return source.map(line => {
    const text = compare.value && line.sourceText !== undefined && line.sourceText !== line.text ? `${line.sourceText}\n${line.text}` : line.text;
    return line.numericUncertain ? `${text}\n${t('数字识别可能有误，请对照原图')}` : text;
  }).join('\n\n');
}
async function copyText(text: string, event: MouseEvent) {
  if (!event.isTrusted || !opened.value || status.value !== 'ready') return;
  const owner = revision, copyOwner = ++copyRevision;feedback.value = '';
  try {await props.copy(text);if (opened.value && owner === revision && copyOwner === copyRevision) feedback.value = t('已复制');}
  catch {if (opened.value && owner === revision && copyOwner === copyRevision) feedback.value = t('复制失败，请选中文字后手动复制');}
}
function copyPage(event: MouseEvent) {if (event.isTrusted) void copyText(textFor(pages.value[pageIndex.value] ?? []), event);}
function copyAll(event: MouseEvent) {if (event.isTrusted) void copyText(textFor(lines.value), event);}
onBeforeUnmount(() => {disposed = true;cancel();trigger = null;lines.value = [];items.value = [];});
defineExpose({open, close, invalidate});
</script>
<style scoped>
.fr-manga-reading {position:fixed;right:16px;top:16px;width:min(420px,calc(100vw - 24px));max-height:calc(100dvh - 32px);display:flex;flex-direction:column;box-sizing:border-box;background:#fff;color:#172033;border:1px solid #e5e8ef;border-radius:12px;box-shadow:0 12px 40px #17203326;font:13px/1.6 system-ui,sans-serif;pointer-events:auto;z-index:2147483647}
.fr-manga-reading header,.fr-manga-reading footer,.fr-manga-reading-heading,.fr-manga-reading-tools {display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px}.fr-manga-reading header strong {flex:1}.fr-manga-reading button {font:inherit;min-height:30px;cursor:pointer}.fr-manga-reading button:focus-visible {outline:2px solid #dc315f;outline-offset:2px}.fr-manga-reading button:disabled {cursor:default;opacity:.55}.fr-manga-reading-body {overflow:auto;overscroll-behavior:contain;min-height:0;padding:0 14px;user-select:text}.fr-manga-reading-list {display:flex;flex-direction:column;gap:4px}.fr-manga-reading article {padding:12px 0}.fr-manga-reading article+article {border-top:1px solid #e5e8ef}.fr-manga-reading pre {margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.fr-manga-reading-source {color:#667085}.fr-manga-reading footer {border-top:1px solid #e5e8ef}.fr-manga-reading footer span {flex:1}
.fr-manga-reading-context {margin:0;padding:0 12px;color:#667085}
.fr-manga-reading[data-theme=dark] {background:#2b2630;color:#ece5ef;border-color:#49404c}.fr-manga-reading[data-theme=dark] :is(.fr-manga-reading-source,.fr-manga-reading-context) {color:#c1b1c5}
@media (prefers-color-scheme:dark) {.fr-manga-reading[data-theme=auto] {background:#2b2630;color:#ece5ef;border-color:#49404c}.fr-manga-reading[data-theme=auto] :is(.fr-manga-reading-source,.fr-manga-reading-context) {color:#c1b1c5}}
</style>
