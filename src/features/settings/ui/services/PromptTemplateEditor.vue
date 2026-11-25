<!--
 * @file src/features/settings/ui/services/PromptTemplateEditor.vue
 * 文件职责：为 AI 翻译服务提供统一的 system/user 提示词编辑器，并用标签旁提示解释角色，并把模板变量变成可点击插入的快捷操作。
 * 主要内容：渲染角色提示词编辑器，保留光标和选区；以本地草稿衔接父级回传，按配置上下文丢弃过期组合事件并合并焦点任务；支持点击 {{to}}、{{origin}} 按钮插入变量。
 * 模块边界：组件只管理编辑器展示、光标位置和 update:modelValue 事件，不解释翻译协议、不保存配置；父级 ServiceConfiguration 负责服务映射与持久化。
 -->
<template>
  <section
    class="prompt-template-field"
    role="group"
    :data-testid="`prompt-editor-${role}`"
    :data-prompt-role="role"
    :aria-labelledby="headingId"
  >
    <header class="prompt-template-header">
      <div class="prompt-template-role">
        <span class="prompt-role-badge" aria-hidden="true">{{ props.roleLabel || role }}</span>
        <div class="prompt-role-copy">
          <strong :id="headingId">{{ definition.title }}</strong>
          <FieldHelp :content="definition.description" />
        </div>
      </div>
      <span class="prompt-template-limit">{{ props.limitLabel || `最多 ${maxLength} 字符` }}</span>
    </header>

    <!-- 组合期间由原生节点保管临时文本，其他响应式更新不能回填旧草稿。 -->
    <textarea
      ref="textarea"
      class="prompt-template-textarea"
      :key="`${revision}:${nodeRevision}`"
      :value="isComposing ? textarea?.value : draft"
      :disabled="!active"
      :aria-label="props.ariaLabel || `${role} 提示词`"
      :maxlength="lengthLimit"
      :placeholder="definition.placeholder"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      rows="4"
      :onClick="actions.rememberSelection"
      :onFocus="actions.rememberSelection"
      :onInput="actions.handleInput"
      :onCompositionstart="actions.handleCompositionStart"
      :onCompositionend="actions.handleCompositionEnd"
      :onKeyup="actions.rememberSelection"
      :onMouseup="actions.rememberSelection"
      :onSelect="actions.rememberSelection"
    />

    <footer v-if="promptTokens.length" class="prompt-template-footer">
      <span class="prompt-template-hint">{{ props.tokenHint || '快速插入变量' }}</span>
      <div class="prompt-token-list" :aria-label="props.tokenListAriaLabel || '可插入的提示词变量'">
        <button
          v-for="token in promptTokens"
          :key="token.value"
          type="button"
          class="prompt-token"
          :data-prompt-token="token.value"
          :aria-label="props.tokenAriaLabel?.(token) || `插入 ${token.value}（${token.label}）`"
          @mousedown.prevent
          :disabled="!canInsertToken(token.value)"
          :onClick="actions.forToken(token.value)"
        >
          <code>{{ token.value }}</code>
          <span>{{ token.label }}</span>
        </button>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import FieldHelp from '../components/FieldHelp.vue'
import {useSettingsActionContext} from '../../model/useSettingsActionContext'

type PromptRole = 'system' | 'user'

interface PromptToken {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  role: PromptRole
  modelValue: string
  active?: boolean
  context?: unknown
  contextKey?: unknown
  maxLength?: number
  roleLabel?: string
  title?: string
  description?: string
  placeholder?: string
  ariaLabel?: string
  limitLabel?: string
  tokenHint?: string
  tokenListAriaLabel?: string
  tokenAriaLabel?: (token: PromptToken) => string
  tokens?: PromptToken[]
}>(), {
  active: true,
  context: undefined,
  contextKey: undefined,
  maxLength: 8192,
  roleLabel: undefined,
  title: undefined,
  description: undefined,
  placeholder: undefined,
  ariaLabel: undefined,
  limitLabel: undefined,
  tokenHint: undefined,
  tokenListAriaLabel: undefined,
  tokenAriaLabel: undefined,
  tokens: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const textarea = shallowRef<HTMLTextAreaElement | null>(null)
const selection = ref({start: props.modelValue.length, end: props.modelValue.length})
const isComposing = ref(false)
const draft = ref(props.modelValue)
const nodeRevision = ref(0)
const editingRevision = ref(0)
let lastPublishedValue = props.modelValue
let focusRevision = 0
let compositionOwner: (() => boolean) | undefined
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.context, props.contextKey, props.role])
const id = useId()
const headingId = computed(() => `fluentread-${props.role}-prompt-${id}`)
const lengthLimit = computed(() => Number.isFinite(props.maxLength) ? Math.max(0, Math.trunc(props.maxLength)) : 8192)

function resetEditing(): void {
  // 只在中断原生组合时更换节点；普通父级回传保留焦点与选区。
  if (isComposing.value) nodeRevision.value += 1
  isComposing.value = false
  compositionOwner = undefined
  focusRevision += 1
  editingRevision.value += 1
  draft.value = lastPublishedValue = props.modelValue
  selection.value = {start: draft.value.length, end: draft.value.length}
}
watch(revision, resetEditing, {flush: 'sync'})
watch(() => props.modelValue, value => {
  if (value !== lastPublishedValue) resetEditing()
}, {flush: 'sync'})

const promptTokens = computed<PromptToken[]>(() => props.tokens || (props.role === 'user'
  ? [
      {value: '{{to}}', label: '目标语言'},
      {value: '{{origin}}', label: '待翻译原文'},
    ]
  : []))

const definition = computed(() => props.role === 'system'
  ? {
      title: props.title || '系统提示词',
      description: props.description || '定义翻译角色、语气与输出规则',
      placeholder: props.placeholder || '例如：You are a professional translator.',
    }
  : {
      title: props.title || '用户提示词',
      description: props.description || '描述翻译任务，可引用原文和目标语言',
      placeholder: props.placeholder || '例如：Translate {{origin}} into {{to}}.',
    })

function captureEditing(): () => boolean {
  const current = capture(), edited = editingRevision.value
  return () => current() && edited === editingRevision.value
}

function selectedRange() {
  const size = draft.value.length
  const start = Number.isFinite(selection.value.start) ? Math.max(0, Math.min(Math.trunc(selection.value.start), size)) : size
  const end = Number.isFinite(selection.value.end) ? Math.max(start, Math.min(Math.trunc(selection.value.end), size)) : size
  return {start, end}
}

function canInsertToken(token: string): boolean {
  const {start, end} = selectedRange()
  return active.value && !isComposing.value && promptTokens.value.some(item => item.value === token)
    && draft.value.length - (end - start) + token.length <= lengthLimit.value
}

function rememberSelection(): void {
  if (!active.value || !textarea.value) return
  focusRevision += 1
  selection.value = {start: textarea.value.selectionStart, end: textarea.value.selectionEnd}
}

function ownsInput(event: Event): event is Event & {currentTarget: HTMLTextAreaElement} {
  return active.value && event.currentTarget instanceof HTMLTextAreaElement && event.currentTarget === textarea.value
}

function publish(value: string): void {
  draft.value = value
  if (value === lastPublishedValue) return
  lastPublishedValue = value
  emit('update:modelValue', value)
}

function handleInput(event: Event): void {
  if (!ownsInput(event)) return
  focusRevision += 1
  if ((event as Event & {isComposing?: boolean}).isComposing === true) {
    if (!isComposing.value) compositionOwner = captureEditing()
    isComposing.value = true
  }
  if (!isComposing.value) {
    if (event.currentTarget.value.length > lengthLimit.value) event.currentTarget.value = draft.value
    else publish(event.currentTarget.value)
  }
  rememberSelection()
}

function handleCompositionStart(event: Event): void {
  if (!ownsInput(event)) return
  focusRevision += 1
  compositionOwner = captureEditing()
  isComposing.value = true
}

function handleCompositionEnd(event: Event): void {
  if (!ownsInput(event) || !compositionOwner?.()) return
  isComposing.value = false
  compositionOwner = undefined
  handleInput(event)
}

function insertToken(token: string): void {
  if (!canInsertToken(token)) return
  const input = textarea.value, current = captureEditing(), {start, end} = selectedRange()
  const previousFocus = input?.ownerDocument.activeElement
  const cursor = start + token.length, pendingFocus = ++focusRevision
  selection.value = {start: cursor, end: cursor}
  publish(`${draft.value.slice(0, start)}${token}${draft.value.slice(end)}`)
  void nextTick(() => {
    if (!current() || pendingFocus !== focusRevision || !input || input !== textarea.value) return
    const focused = input.ownerDocument.activeElement
    if (focused !== previousFocus && focused !== input) return
    input.focus({preventScroll: true})
    input.setSelectionRange(cursor, cursor)
  })
}

// 直接绑定本次渲染捕获的函数，避免 Vue 缓存包装器在迟到事件中借用新上下文。
const actions = computed(() => {
  const current = captureEditing()
  return {
    rememberSelection: () => {if (current()) rememberSelection()},
    handleInput: (event: Event) => {if (current()) handleInput(event)},
    handleCompositionStart: (event: Event) => {if (current()) handleCompositionStart(event)},
    handleCompositionEnd: (event: Event) => {if (current()) handleCompositionEnd(event)},
    forToken: (token: string) => () => {if (current()) insertToken(token)},
  }
})
</script>

<style scoped>
.prompt-template-field {
  display: grid;
  gap: 0;
  padding: 15px 16px 13px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface-soft);
  transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
}

.prompt-template-field:hover {
  border-color: #efb5c5;
  background: var(--surface);
  box-shadow: 0 8px 22px rgba(31, 40, 61, .045);
}

.prompt-template-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.prompt-template-role {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
}

.prompt-role-badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  min-height: 27px;
  padding: 3px 8px;
  border: 1px solid #f2c4d1;
  border-radius: 8px;
  color: var(--brand-strong);
  background: var(--brand-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 750;
  letter-spacing: .01em;
}

.prompt-role-copy {
  display: flex;
  min-width: 0;
  flex-direction: row;
  align-items: center;
  gap: 4px;
}

.prompt-role-copy strong {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 700;
  line-height: 1.45;
}

.prompt-role-copy small,
.prompt-template-limit,
.prompt-template-hint {
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.5;
}

.prompt-template-limit {
  flex: 0 0 auto;
  padding-top: 4px;
}

.prompt-template-textarea {
  display: block;
  width: 100%;
  min-height: 110px;
  margin-top: 12px;
  padding: 12px 13px;
  border: 1px solid #dfe4ed;
  border-radius: 13px;
  color: var(--ink);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(31, 40, 61, .035);
  outline: none;
  resize: vertical;
  font-family: Inter, "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 13px;
  line-height: 1.65;
  transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
}

.prompt-template-textarea:hover {
  border-color: var(--fr-color-line-strong, var(--line));
}

.prompt-template-textarea:focus {
  border-color: var(--brand);
  background: var(--surface);
  box-shadow: var(--fr-focus-ring, 0 0 0 3px rgba(239, 71, 118, .12));
}

.prompt-template-textarea::placeholder { color: var(--muted); opacity: .82; }

.prompt-template-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}

.prompt-token-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.prompt-token {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 29px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--fr-control-radius, 8px);
  color: var(--ink);
  background: var(--surface);
  cursor: pointer;
  transition: border-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), transform var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}

.prompt-token:disabled { opacity: .55; cursor: default; }

.prompt-token:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--brand) 38%, var(--line));
  color: var(--brand-strong);
  background: var(--brand-soft);
}

.prompt-token:active:not(:disabled) {
  transform: scale(.97);
}

.prompt-token:focus-visible {
  outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong));
  outline-offset: 2px;
}

.prompt-token code {
  color: var(--brand-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fr-text-xs, 11px);
  font-weight: 700;
}

.prompt-token span {
  color: var(--muted);
  font-size: var(--fr-text-xs, 11px);
}

:root.dark .prompt-template-field:hover { border-color: rgba(255, 138, 171, .42); }
:root.dark .prompt-role-badge { border-color: rgba(255, 138, 171, .36); }
:root.dark .prompt-template-textarea { border-color: var(--line); }
:root.dark .prompt-token { border-color: var(--line); }

@media (max-width: 700px) {
  .prompt-template-header,
  .prompt-template-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .prompt-template-limit { padding-top: 0; }
  .prompt-template-textarea { min-height: 150px; }
  .prompt-token-list { justify-content: flex-start; }
}
</style>
