<!--
 * @file src/features/personal-corrections/ui/PersonalCorrectionPanel.vue
 * 文件职责：呈现网页原译文对的主动校订、明确范围预览与个人译法管理。
 * 主要内容：在封闭 Shadow UI 内提供可编辑译文、精确命中预览、近似句差异与个人译法管理；自有根节点启用旧文案迁移，紧凑语言名与含用户名称的范围标签显式本地化，保留分层 Escape、焦点约束与主题布局。
 * 模块边界：不读取网页历史或存储、不请求翻译服务；动作交给校订控制器，原文和译文始终以纯文本呈现。
 -->
<template>
  <div v-ui-i18n class="correction-ui" :class="{dark}">
    <button v-if="state.candidate && !state.open" class="correction-entry" data-testid="correction-entry" type="button" @click="controller.open(state.candidate)">
      校订译文 <span>Alt ⇧ E</span>
    </button>
    <section v-if="state.open" ref="panel" class="correction-panel" role="dialog" aria-modal="true" aria-labelledby="correction-title" data-testid="correction-dialog" @keydown="keydown">
      <header><h2 id="correction-title">{{ state.managing ? '已保存的校订' : '校订译文' }}</h2><button data-testid="correction-close" type="button" :disabled="state.busy" aria-label="关闭校订" @click="controller.close">×</button></header>
      <nav class="tabs" aria-label="校订视图"><div class="tab-actions"><button type="button" :aria-pressed="!state.managing" :disabled="state.busy" @click="state.managing = false">编辑译文</button><button data-testid="correction-manage" type="button" :aria-pressed="state.managing" :disabled="state.busy" @click="state.managing = true">已保存的校订 <span>{{ state.entries.length }}</span></button></div><span class="language-pair" data-testid="correction-language" :title="`${languagePair} (${state.sourceLanguage} → ${state.targetLanguage})`" data-i18n-ignore>{{ languagePair }}</span></nav>
      <div class="panel-body">
        <p v-if="state.loading" role="status" class="hint">正在读取个人校订…</p>
        <template v-if="!state.managing">
          <h3>原文</h3><blockquote class="source" data-testid="correction-source" data-i18n-ignore>{{ state.source }}</blockquote>
          <label class="translation-label" for="correction-translation">确认采用的译文</label>
          <textarea id="correction-translation" ref="translationInput" data-testid="correction-translation" :value="state.draft" :disabled="state.busy" maxlength="20000" rows="4" data-i18n-ignore @input="controller.setDraft(($event.target as HTMLTextAreaElement).value)" />
          <button v-if="state.scopeId !== 'material' && state.activeProjectId !== state.scopeId" type="button" data-testid="correction-project-join" :disabled="state.busy" @click="controller.activateProject(state.scopeId)">将当前网页加入此项目</button>
          <p v-if="state.activeProjectId" class="hint">当前网页已加入项目：<span data-i18n-ignore>{{ state.projects.find(project => project.id === state.activeProjectId)?.label }}</span> <button type="button" data-testid="correction-project-leave" :disabled="state.busy" @click="controller.activateProject(null)">退出项目</button></p>
          <div v-if="state.conflicts.length" class="conflict"><h3>这个原句保存了不同译法</h3><p class="hint">不会自动采用。可以编辑已有译法，或在“已保存的校订”中删除不再使用的译法。</p><button v-for="record in state.conflicts" :key="record.id" type="button" @click="controller.edit(record)"><span data-i18n-ignore>{{ record.translation }}</span><small data-i18n-ignore>{{ record.scope.label }}</small></button></div>
          <details v-if="state.suggestions.length" class="suggestions"><summary>相近原句的参考译文（不会自动替换）</summary><article v-for="record in state.suggestions" :key="record.id"><div class="diff"><p><strong>已保存的原句</strong><span data-i18n-ignore>{{ record.source }}</span></p><p><strong>当前原句</strong><span data-i18n-ignore>{{ state.source }}</span></p></div><p data-i18n-ignore>{{ record.translation }}</p><button type="button" :disabled="state.busy" @click="controller.suggest(record)">选作草稿，再预览确认</button></article></details>
          <div v-if="state.previewed" class="preview" data-testid="correction-preview-result"><h3>确认预览</h3><div class="comparison"><div><small>当前译文</small><p data-i18n-ignore>{{ state.currentTranslation }}</p></div><div><small>采用校订后</small><p data-i18n-ignore>{{ state.draft }}</p></div></div><p class="hint" data-testid="correction-affected-count">当前网页有 {{ state.affected.length }} 处相同原句。出现不同的已保存译法时，不会自动采用。</p><details v-if="state.affected.length"><summary>受影响句子</summary><ol><li v-for="(pair, index) in state.affected" :key="index"><p data-i18n-ignore>{{ pair.source }}</p><small data-i18n-ignore>{{ pair.translation }}</small></li></ol></details></div>
        </template>
        <template v-else>
          <p class="hint">这里只保存你确认过的原句和译文。修改或删除后，旧译文会立即停止使用。</p>
          <p v-if="!state.entries.length && !state.loading" class="empty">尚未保存个人校订。</p>
          <article v-for="record in state.entries" :key="record.id" class="saved-entry" :data-correction-record="record.id"><div class="record-meta"><span data-i18n-ignore>{{ t(record.scope.kind === 'project' ? 'personalCorrections.projectName' : 'personalCorrections.pageName', {name: record.scope.label}) }}</span><small data-i18n-ignore>{{ record.sourceLanguage }} → {{ record.targetLanguage }}</small></div><p class="source" data-i18n-ignore>{{ record.source }}</p><p data-i18n-ignore>{{ record.translation }}</p><details v-if="record.context"><summary>所在章节</summary><p data-i18n-ignore>{{ record.context }}</p></details><p v-if="record.scope.kind === 'material' && record.scope.id !== state.materialId" class="hint">打开对应网页后可编辑。</p><div class="record-actions"><button type="button" :data-correction-edit="record.id" :disabled="state.busy || (record.scope.kind === 'material' && record.scope.id !== state.materialId)" @click="controller.edit(record)">编辑</button><button type="button" class="danger" :data-correction-delete="record.id" :disabled="state.busy" @click="controller.remove(record)">删除</button></div></article>
        </template>
        <p v-if="state.error" class="error" role="alert" data-testid="correction-error">{{ state.error }}</p>
        <p v-if="state.notice" class="notice" role="status" data-testid="correction-notice">{{ state.notice }}</p>
      </div>
      <footer>
        <button v-if="state.undoToken" type="button" data-testid="correction-undo" :disabled="state.busy" @click="controller.undo">撤销上次操作</button>
        <div v-if="!state.managing" class="scope-row"><label class="scope-label" for="correction-scope">使用范围</label><select id="correction-scope" data-testid="correction-scope" data-i18n-ignore :title="scopeLabel" :value="state.scopeId" :disabled="state.busy" @change="controller.setScope(($event.target as HTMLSelectElement).value)"><option value="material">{{ t('personalCorrections.currentPage') }}</option><option v-for="project in state.projects" :key="project.id" :value="project.id" data-i18n-ignore>{{ t('personalCorrections.projectName', {name: project.label}) }}</option></select><button ref="scopeHelpButton" class="scope-help" type="button" data-testid="correction-scope-help" aria-label="使用范围说明" :aria-expanded="scopeHelpOpen" :aria-describedby="scopeHelpOpen ? 'correction-scope-tooltip' : undefined" @mouseenter="openScopeHelp" @mouseleave="deferScopeHelpClose" @focus="openScopeHelp" @blur="closeScopeHelp"><svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" /><path d="M8 7v4M8 4.5v.5" /></svg></button><details ref="projectCreation" class="new-project"><summary>新建项目</summary><div><input v-model="state.projectName" data-testid="correction-project-name" :disabled="state.busy" maxlength="80" aria-label="项目名称" placeholder="例如：某篇论文的相关网页"><button type="button" data-testid="correction-project-create" :disabled="state.busy" @click="createProject">创建</button></div></details></div>
        <div v-if="!state.managing" class="save-actions"><button type="button" data-testid="correction-preview" :disabled="state.busy || state.loading || !state.draft.trim()" @click="controller.preview">预览受影响句子</button><button class="primary" type="button" data-testid="correction-save" :disabled="state.busy || state.loading || !state.previewed" @click="controller.save">{{ state.busy ? '保存中…' : '确认保存' }}</button></div>
      </footer>
    </section>
    <div v-if="scopeHelpOpen" id="correction-scope-tooltip" ref="scopeHelp" class="scope-tooltip" role="tooltip" data-testid="correction-scope-tooltip" :style="scopeHelpPosition" @mouseenter="openScopeHelp" @mouseleave="deferScopeHelpClose">
      <p>默认只在当前网页使用。项目是一组相关网页，只有主动加入同一项目的网页，才会使用其中保存的译文。</p>
      <p>原句、翻译语言（源语言和目标语言）及所在章节标题须完全相同。同一项目的其他网页会在下次翻译时使用校订。</p>
      <small>当前章节</small><p class="scope-tooltip-context" data-i18n-ignore>{{ state.context || t('personalCorrections.noChapter') }}</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {config, subscribeConfig} from '@/src/services/config/store';
import {translationLanguageOptions} from '@/src/core/language/catalog';
import {normalizeLanguageCode} from '@/src/core/language/codes';
import {getMultilingualTargetLanguageLabel} from '@/src/core/config/catalog';
import {useUiI18n} from '@/src/ui/i18n';
import type {PersonalCorrectionController} from '../controller';

const props = defineProps<{controller: PersonalCorrectionController}>();
const state = props.controller.state;
const {t, language, translateLegacy} = useUiI18n();
function languageLabel(value: string): string {
  if (value === 'auto') return translateLegacy('自动检测');
  const code = normalizeLanguageCode(value);
  const fallback = translationLanguageOptions.find(item => item.value === code)?.label ?? value;
  return getMultilingualTargetLanguageLabel(code, fallback, language.value).split(' / ')[0]!;
}
const languagePair = computed(() => `${languageLabel(state.sourceLanguage)} → ${languageLabel(state.targetLanguage)}`);
const scopeLabel = computed(() => state.scopeId === 'material' ? t('personalCorrections.currentPage') : state.projects.find(project => project.id === state.scopeId)?.label ?? t('personalCorrections.project'));
const panel = ref<HTMLElement>(); const translationInput = ref<HTMLTextAreaElement>();
const scopeHelpButton = ref<HTMLButtonElement>(); const scopeHelp = ref<HTMLElement>();
const projectCreation = ref<HTMLDetailsElement>();
const scopeHelpOpen = ref(false); const scopeHelpPosition = ref({left: '8px', top: '8px'});
let helpCloseTimer: ReturnType<typeof setTimeout> | undefined;
let helpPanel: HTMLElement | undefined;
let disposed = false;
async function createProject(): Promise<void> {
  const details = projectCreation.value;
  if (disposed || !state.open || state.managing || !details) return;
  await props.controller.createProject();
  if (disposed || !state.open || state.managing || projectCreation.value !== details || state.error || state.projectName) return;
  details.removeAttribute('open');
  panel.value!.querySelector<HTMLSelectElement>('[data-testid="correction-scope"]')!.focus({preventScroll: true});
}
function positionScopeHelp(): void {
  const button = scopeHelpButton.value, tooltip = scopeHelp.value;
  if (!button || !tooltip) return;
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
  tooltip.style.maxWidth = `${Math.max(0, width - 16)}px`; tooltip.style.maxHeight = `${Math.max(0, height - 16)}px`;
  const anchor = button.getBoundingClientRect(), bounds = tooltip.getBoundingClientRect();
  const leftEdge = (viewport?.offsetLeft ?? 0) + 8, topEdge = (viewport?.offsetTop ?? 0) + 8;
  const rightEdge = leftEdge + width - 16;
  const bottomEdge = topEdge + height - 16;
  const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - bounds.width));
  const preferredTop = anchor.top - bounds.height - 6 >= topEdge ? anchor.top - bounds.height - 6 : anchor.bottom + 6;
  const top = Math.max(topEdge, Math.min(preferredTop, bottomEdge - bounds.height));
  scopeHelpPosition.value = {left: `${left}px`, top: `${top}px`};
}
function closeScopeHelp(): void {
  clearTimeout(helpCloseTimer); helpCloseTimer = undefined; scopeHelpOpen.value = false;
  helpPanel?.removeEventListener('scroll', positionScopeHelp, true); helpPanel = undefined;
  window.removeEventListener('resize', positionScopeHelp); window.removeEventListener('scroll', positionScopeHelp, true);
  window.visualViewport?.removeEventListener('resize', positionScopeHelp); window.visualViewport?.removeEventListener('scroll', positionScopeHelp);
}
async function openScopeHelp(): Promise<void> {
  if (disposed || !state.open || state.managing || !panel.value) return;
  clearTimeout(helpCloseTimer); helpCloseTimer = undefined; scopeHelpOpen.value = true;
  helpPanel = panel.value; helpPanel.addEventListener('scroll', positionScopeHelp, true);
  window.addEventListener('resize', positionScopeHelp); window.addEventListener('scroll', positionScopeHelp, true);
  window.visualViewport?.addEventListener('resize', positionScopeHelp); window.visualViewport?.addEventListener('scroll', positionScopeHelp);
  await nextTick();
  if (scopeHelpOpen.value) positionScopeHelp();
}
function deferScopeHelpClose(): void {
  if (disposed || !scopeHelpOpen.value) return;
  clearTimeout(helpCloseTimer);
  const root = scopeHelpButton.value?.getRootNode() as Document | ShadowRoot;
  if (root?.activeElement === scopeHelpButton.value) return;
  helpCloseTimer = setTimeout(closeScopeHelp, 100);
}
const prefs = ref({theme: config.theme});
const media = window.matchMedia('(prefers-color-scheme: dark)'); const systemDark = ref(media.matches);
const mediaChanged = (event: MediaQueryListEvent) => {systemDark.value = event.matches;};
media.addEventListener('change', mediaChanged);
const stopConfig = subscribeConfig(value => {prefs.value = {theme: value.theme};});
const dark = computed(() => prefs.value.theme === 'dark' || (prefs.value.theme === 'auto' && systemDark.value));
let previousFocus: HTMLElement | null = null;
function restoreFocus(): void {if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true}); previousFocus = null;}
watch(() => state.open, async open => {
  if (!open) {closeScopeHelp(); restoreFocus(); return;}
  const focus = document.activeElement;
  previousFocus = focus instanceof HTMLElement ? focus : null;
  await nextTick();
  if (state.open) (translationInput.value ?? panel.value?.querySelector<HTMLButtonElement>('[data-testid="correction-manage"]'))?.focus({preventScroll: true});
}, {immediate: true});
watch(() => state.managing, async managing => {closeScopeHelp(); await nextTick(); if (state.open) (managing ? panel.value?.querySelector<HTMLButtonElement>('[data-correction-edit]:not([disabled])') ?? panel.value?.querySelector<HTMLButtonElement>('[data-testid="correction-manage"]') : translationInput.value)?.focus({preventScroll: true});});
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); if (scopeHelpOpen.value) closeScopeHelp(); else props.controller.close(); return;}
  if (event.key !== 'Tab') return;
  const controls = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]), summary') ?? [])
    .filter(node => !node.closest('details:not([open])') || node.tagName === 'SUMMARY');
  if (!controls.length) return;
  const first = controls[0], last = controls[controls.length - 1]; const active = panel.value?.getRootNode() as ShadowRoot;
  const focus = active?.activeElement ?? document.activeElement;
  if (event.shiftKey && focus === first) {event.preventDefault(); last.focus();}
  else if (!event.shiftKey && focus === last) {event.preventDefault(); first.focus();}
}
onBeforeUnmount(() => {disposed = true; closeScopeHelp(); stopConfig(); media.removeEventListener('change', mediaChanged); restoreFocus();});
</script>
<style scoped>
/* 沿用写作面板的中性底面、字号与留白；阅读面板的轻操作页签只强调当前视图。 */
.correction-ui{--accent:#ef4776;--text:#28323f;--muted:#7c8799;--surface:#fff;--soft:#f7f8fb;--line:#e9edf3;--danger:#b1435e;color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:normal;direction:ltr;color-scheme:light}
.dark{--text:#edf0f5;--muted:#a1a8b5;--surface:#24262e;--soft:#2c2e38;--line:#393c48;--danger:#f1a7bc;color-scheme:dark}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--line);border-radius:7px;background:var(--surface);padding:5px 10px;min-height:32px;font-size:12px;line-height:1.5}
button:hover{background:var(--soft)}button:disabled{cursor:default;opacity:.45}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.primary:hover{filter:brightness(.96);background:var(--accent)}
.correction-entry{position:fixed;right:18px;bottom:18px;box-shadow:0 3px 14px #152c4118;display:flex;gap:8px;align-items:center}.correction-entry span{font-size:11px;color:var(--muted)}
.correction-panel{position:fixed;right:18px;bottom:18px;width:min(590px,calc(100vw - 36px));max-height:calc(100dvh - 36px);display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 48px #152c4122;overflow:hidden}
header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;gap:8px}h2{margin:0;font-size:14px;line-height:1.4;font-weight:650}header button{padding:0;font-size:20px;border:0;background:transparent;color:var(--muted);width:28px;min-height:28px;border-radius:6px}
.tabs{display:flex;align-items:center;gap:16px;padding:0 14px;border-bottom:1px solid var(--line);flex:none}.tab-actions{display:flex;gap:4px;flex:none}.tabs button{color:var(--muted);border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:5px 8px;white-space:nowrap}.tabs button:hover{background:var(--soft)}.tabs button[aria-pressed=true]{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}.tab-actions span{margin-left:3px;font-size:11px}.language-pair{margin-inline-start:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--muted);font-size:11px;line-height:1.4}
.panel-body{overflow:auto;padding:14px;overscroll-behavior:contain;min-height:0}header{flex:none}h3{font-size:12px;margin:0 0 6px}
p,blockquote{margin:0 0 10px;white-space:pre-wrap;overflow-wrap:anywhere}blockquote{border-left:2px solid var(--line);padding:8px 10px;background:var(--soft);border-radius:0 7px 7px 0}.source{color:var(--muted)}
.translation-label{font-size:12px;font-weight:600;display:block;margin-top:14px}textarea,input,select{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px}textarea{width:100%;resize:vertical;min-height:100px;max-height:260px;margin-top:6px;font-size:14px;line-height:1.8}input{min-width:0;flex:1}input,select{font-size:12px}
.scope-row{display:flex;gap:4px;align-items:center;flex:none;min-width:0}.scope-label{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.scope-row select{flex:none;width:128px;max-width:160px;height:30px;padding:4px 24px 4px 8px;border-radius:7px;text-overflow:ellipsis;white-space:nowrap}.scope-help{display:inline-flex;align-items:center;justify-content:center;width:24px;min-height:24px;padding:0;border:0;background:transparent;color:var(--muted)}.scope-help svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round}.hint{font-size:11px;color:var(--muted);line-height:1.7}
.new-project{font-size:11px;flex:none}.new-project summary{list-style:none;white-space:nowrap;padding:4px 2px}.new-project summary::-webkit-details-marker{display:none}.new-project>div{position:absolute;left:14px;bottom:calc(100% + 8px);width:min(320px,calc(100vw - 40px));display:flex;gap:6px;padding:8px;border:1px solid var(--line);border-radius:9px;background:var(--surface);box-shadow:0 5px 20px #152c4122;z-index:1}summary{cursor:pointer;color:var(--muted)}
.scope-tooltip{position:fixed;z-index:2;width:min(320px,calc(100vw - 16px));max-height:min(360px,calc(100dvh - 16px));overflow:auto;overscroll-behavior:contain;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text);font-size:11px;line-height:1.7;box-shadow:0 5px 20px #152c4122}.scope-tooltip p{margin:0 0 8px}.scope-tooltip small{color:var(--muted);font-size:10px}.scope-tooltip .scope-tooltip-context{margin:2px 0 0;color:var(--muted)}
.conflict,.preview{margin-top:14px;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--soft)}.conflict button{display:flex;justify-content:space-between;text-align:left;gap:8px;width:100%;margin-top:5px}.conflict small{color:var(--muted)}
.suggestions{margin:12px 0;font-size:12px}.suggestions article{border-bottom:1px solid var(--line);padding:10px 0}.diff{display:grid;grid-template-columns:1fr 1fr;gap:8px}.diff strong{font-size:11px;color:var(--muted);display:block}.diff span{font-size:12px}
.comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px}.comparison>div{min-width:0}.comparison small{color:var(--muted);font-size:11px}.comparison p{margin-top:5px}.preview ol{padding-left:20px;margin:8px 0}.preview li{margin-bottom:8px}.preview li p{margin-bottom:3px}.preview small{color:var(--muted);font-size:11px}
.saved-entry{border-bottom:1px solid var(--line);padding:10px 0;margin-bottom:8px}.record-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--muted);margin-bottom:6px}.record-meta span{overflow-wrap:anywhere}.saved-entry details{font-size:11px}.record-actions{display:flex;justify-content:flex-end;gap:6px}.danger{color:var(--danger)}.error{color:var(--danger);font-size:12px;margin-top:10px}.notice{color:var(--muted);font-size:11px;margin-top:10px}.empty{color:var(--muted);font-size:12px}
footer{position:relative;border-top:1px solid var(--line);padding:8px 14px;display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;flex:none}.save-actions{display:flex;gap:6px;margin-left:auto}
@media(max-width:480px){.correction-entry{right:12px;bottom:12px}.correction-panel{right:8px;bottom:8px;width:calc(100vw - 16px);max-height:calc(100dvh - 16px);border-radius:12px}header,.panel-body,footer{padding-left:10px;padding-right:10px}.tabs{padding-left:10px;padding-right:10px;gap:8px}.language-pair{font-size:10px}.comparison,.diff{grid-template-columns:1fr}.new-project>div{left:10px}.save-actions{width:100%;justify-content:flex-end}.record-meta{align-items:flex-start}.record-meta small{white-space:nowrap}}
</style>
