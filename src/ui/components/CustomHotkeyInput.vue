<!--
 @file src/ui/components/CustomHotkeyInput.vue
 文件职责：提供可复用的自定义快捷键对话框，支持键盘录制、预设选择、冲突校验、清除与无障碍确认流程。
 主要内容：通过 Teleport 渲染模态层，接收 modelValue/currentValue/context props，捕获 keydown/keyup 组合并调用 parseHotkey 与 validateHotkeyConflicts，展示录制、错误、警告和成功状态，发出 update、confirm、cancel。
 模块边界：组件只产生规范化快捷键值，不持久化配置、不绑定具体悬浮或划词动作，也不注册页面级永久监听；调用方决定上下文和保存策略，解析规则归 core/hotkey。
-->
<template>
  <Teleport to="body">
    <div
      v-ui-i18n
      v-if="dialogVisible"
      class="custom-hotkey-overlay"
      role="presentation"
      @keydown.esc="handleCancel"
    >
      <section
        ref="dialogRoot"
        class="custom-hotkey-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-hotkey-title"
        aria-describedby="custom-hotkey-description"
        tabindex="-1"
        @click.stop
        @keydown.tab="trapFocus"
      >
        <header class="dialog-header">
          <div class="dialog-heading">
            <span class="dialog-eyebrow">交互设置</span>
            <h2 id="custom-hotkey-title">自定义快捷键</h2>
            <p id="custom-hotkey-description">为当前功能设置一个顺手、易记且不容易冲突的按键组合。</p>
          </div>
          <button class="dialog-close" type="button" aria-label="关闭自定义快捷键" @click="handleCancel">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div class="dialog-body">
          <section class="recording-card" :class="{ 'is-recording': isRecording }">
            <div class="section-heading">
              <div>
                <span class="section-eyebrow">录制组合</span>
                <h3>按下你想使用的快捷键</h3>
              </div>
              <span class="state-badge" :class="{ active: isRecording, ready: !!currentHotkey && !isRecording }">
                {{ isRecording ? '录制中' : currentHotkey ? '已设置' : '待设置' }}
              </span>
            </div>

            <button
              ref="inputField"
              type="button"
              class="hotkey-input-field"
              :class="{
                recording: isRecording,
                error: !!errorMessage,
                warning: !!conflictWarning,
                success: isValidHotkey
              }"
              :aria-label="isRecording ? '正在录制快捷键，请按下组合键' : currentHotkey ? `当前快捷键为 ${displayHotkey}` : '点击开始录制快捷键'"
              @click="startRecording"
              @keydown="handleKeyDown"
              @keyup="handleKeyUp"
            >
              <span v-if="!isRecording && !currentHotkey" class="placeholder">
                点击后按下快捷键组合
              </span>
              <span v-else-if="isRecording" class="recording-text">
                <el-icon class="recording-icon"><Loading /></el-icon>
                正在录制，请按下快捷键…
              </span>
              <span v-else class="hotkey-display">
                <kbd>{{ displayHotkey }}</kbd>
              </span>
            </button>

            <p class="field-hint">支持 Ctrl、Alt、Shift 与字母或功能键组合；不支持使用 CMD/Meta 键。</p>
          </section>

          <div
            v-if="errorMessage || conflictWarning || isValidHotkey"
            class="hotkey-status"
            :class="{ error: !!errorMessage, warning: !!conflictWarning && !errorMessage, success: isValidHotkey }"
            :role="errorMessage ? 'alert' : 'status'"
            aria-live="polite"
          >
            <el-icon v-if="errorMessage"><WarningFilled /></el-icon>
            <el-icon v-else-if="conflictWarning"><Warning /></el-icon>
            <el-icon v-else><CircleCheckFilled /></el-icon>
            <span>{{ errorMessage || conflictWarning || '快捷键有效，可以使用' }}</span>
          </div>

          <section class="preset-section">
            <div class="section-heading preset-heading">
              <div>
                <span class="section-eyebrow">快速选择</span>
                <h3>推荐快捷键</h3>
              </div>
              <span class="section-note">也可以直接录制</span>
            </div>
            <div class="preset-buttons">
              <button
                v-for="preset in recommendedHotkeys"
                :key="preset.value"
                type="button"
                class="preset-button"
                :class="{ selected: currentHotkey === preset.value }"
                :aria-label="preset.label"
                :aria-pressed="currentHotkey === preset.value"
                @click="selectPreset(preset.value)"
              >
                <span class="preset-label">{{ currentHotkey === preset.value ? '当前选择' : '使用' }}</span>
                <kbd>{{ preset.label }}</kbd>
              </button>
            </div>
          </section>

          <aside class="help-section">
            <span class="help-icon" aria-hidden="true">i</span>
            <p>建议使用修饰键组合，避免与浏览器、系统或网页已有快捷键冲突。设置完成后，快捷键会立即应用。</p>
          </aside>
        </div>

        <footer class="dialog-footer">
          <button v-if="currentHotkey" class="clear-button" type="button" @click="clearHotkey">清除快捷键</button>
          <div class="dialog-actions">
            <button class="secondary-button" type="button" @click="handleCancel">取消</button>
            <button class="primary-button" type="button" :disabled="!canConfirm" @click="handleConfirm">确认</button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts" name="CustomHotkeyInput">
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue';
import { ElIcon } from 'element-plus';
import { Loading, WarningFilled, Warning, CircleCheckFilled } from '@element-plus/icons-vue';
import {
  normalizeHotkeyEventKey,
  parseHotkey,
  REGULAR_KEYS,
  validateHotkeyConflicts,
  type ParsedHotkey,
} from '@/src/core/hotkey';

// 组件输入
interface Props {
  modelValue: boolean;
  currentValue?: string;
  validate?: (hotkey: string) => string;
}

const props = withDefaults(defineProps<Props>(), {
  currentValue: ''
});

// 组件事件
interface Emits {
  (e: 'update:modelValue', value: boolean): void;
  (e: 'confirm', hotkey: string): void;
  (e: 'cancel'): void;
}

const emit = defineEmits<Emits>();

// 响应式数据
const dialogVisible = computed(() => props.modelValue);

const currentHotkey = ref(props.currentValue || '');
const isRecording = ref(false);
const pressedKeys = ref(new Set<string>());
const errorMessage = ref('');
const conflictWarning = ref('');
const inputField = ref<HTMLElement>();
const dialogRoot = ref<HTMLElement>();
const previouslyFocusedElement = ref<HTMLElement | null>(null);

// 解析当前快捷键
const parsedHotkey = computed<ParsedHotkey | null>(() => {
  if (!currentHotkey.value || currentHotkey.value === 'none') return null;
  return parseHotkey(currentHotkey.value);
});

const isValidHotkey = computed(() => Boolean(
  parsedHotkey.value?.isValid && !errorMessage.value && !conflictWarning.value,
));

const displayHotkey = computed(() => {
  if (currentHotkey.value === 'none') return '已禁用';
  return parsedHotkey.value?.displayName || currentHotkey.value;
});

// 检查是否可以确认
const canConfirm = computed(() => {
  return currentHotkey.value === 'none' || 
         Boolean(parsedHotkey.value?.isValid && !errorMessage.value);
});

// 推荐的快捷键
const recommendedHotkeys = [
  { value: 'Alt+T', label: 'Alt+T' },
  { value: 'Alt+Q', label: 'Alt+Q' },
  { value: 'Alt+D', label: 'Alt+D' },
  { value: 'F9', label: 'F9' },
  { value: 'F10', label: 'F10' },
];

// 监听当前值变化
watch(() => props.currentValue, (newValue) => {
  currentHotkey.value = newValue || '';
});

watch(dialogVisible, (visible) => {
  if (visible) {
    currentHotkey.value = props.currentValue || '';
    isRecording.value = false;
    pressedKeys.value.clear();
    errorMessage.value = '';
    conflictWarning.value = '';
    validateCurrentHotkey(currentHotkey.value);
    previouslyFocusedElement.value = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    nextTick(() => dialogRoot.value?.focus({ preventScroll: true }));
  } else {
    restorePreviousFocus();
  }
}, {immediate: true});

function restorePreviousFocus() {
  const previous = previouslyFocusedElement.value;
  previouslyFocusedElement.value = null;
  nextTick(() => previous?.isConnected && previous.focus({preventScroll: true}));
}
onBeforeUnmount(restorePreviousFocus);

function trapFocus(event: KeyboardEvent) {
  const root = dialogRoot.value;
  if (!root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter(element => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!activeElement || !focusable.includes(activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// 监听快捷键变化，进行验证
watch(currentHotkey, (newValue) => {
  validateCurrentHotkey(newValue);
});

// 验证当前快捷键
function validateCurrentHotkey(hotkeyString: string) {
  errorMessage.value = '';
  conflictWarning.value = '';
  
  if (!hotkeyString || hotkeyString === 'none') return;
  
  const parsed = parseHotkey(hotkeyString);
  
  if (!parsed.isValid) {
    errorMessage.value = parsed.errorMessage || '无效的快捷键';
    return;
  }

  const contextualError = props.validate?.(hotkeyString) || '';
  if (contextualError) {
    errorMessage.value = contextualError;
    return;
  }
  
  // 检查冲突
  const conflictCheck = validateHotkeyConflicts(parsed);
  if (conflictCheck.hasConflict) {
    conflictWarning.value = conflictCheck.conflictDescription || '可能存在冲突';
  }
}

// 开始录制快捷键
async function startRecording() {
  if (isRecording.value) return;
  
  isRecording.value = true;
  pressedKeys.value.clear();
  errorMessage.value = '';
  conflictWarning.value = '';
  
  // 聚焦输入框
  await nextTick();
  inputField.value?.focus();
}

// 处理按键按下
function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    handleCancel();
    return;
  }
  if (!isRecording.value) return;
  
  event.preventDefault();
  event.stopPropagation();
  
  // 记录按下的键
  if (event.ctrlKey) pressedKeys.value.add('ctrl');
  if (event.altKey) pressedKeys.value.add('alt');
  if (event.shiftKey) pressedKeys.value.add('shift');
  if (event.metaKey) pressedKeys.value.add('meta');
  
  // 处理普通按键
  const key = normalizeHotkeyEventKey(event);
  
  // 忽略单独的修饰键
  if (['ctrl', 'alt', 'shift', 'meta'].includes(key)) {
    return;
  }

  // 只记录规则引擎支持的逻辑键；录制与页面运行时必须采用同一种布局语义。
  if (Object.prototype.hasOwnProperty.call(REGULAR_KEYS, key)) pressedKeys.value.add(key);
}

// 处理按键释放
function handleKeyUp(event: KeyboardEvent) {
  if (!isRecording.value) return;
  
  event.preventDefault();
  event.stopPropagation();
  
  // 延迟一点再生成快捷键，确保所有键都被记录
  setTimeout(() => {
    if (pressedKeys.value.size > 0) {
      generateHotkeyFromKeys();
    }
  }, 100);
}

// 从按键生成快捷键字符串
function generateHotkeyFromKeys() {
  const modifiers: string[] = [];
  let regularKey = '';
  
  // 提取修饰键
  if (pressedKeys.value.has('ctrl')) modifiers.push('Ctrl');
  if (pressedKeys.value.has('alt')) modifiers.push('Alt');
  if (pressedKeys.value.has('shift')) modifiers.push('Shift');
  if (pressedKeys.value.has('meta')) modifiers.push('Meta');
  
  // 提取普通按键（找到最后一个非修饰键）
  for (const key of pressedKeys.value) {
    if (!['ctrl', 'alt', 'shift', 'meta'].includes(key)) {
      regularKey = key.toUpperCase();
    }
  }
  
  if (regularKey) {
    currentHotkey.value = [...modifiers, regularKey].join('+');
  }
  
  isRecording.value = false;
  pressedKeys.value.clear();
}

// 选择预设快捷键
function selectPreset(value: string) {
  currentHotkey.value = value;
  isRecording.value = false;
  pressedKeys.value.clear();
}

// 清除快捷键
function clearHotkey() {
  currentHotkey.value = 'none';
  isRecording.value = false;
  pressedKeys.value.clear();
  errorMessage.value = '';
  conflictWarning.value = '';
}

// 确认
function handleConfirm() {
  if (!canConfirm.value) return;
  
  emit('confirm', currentHotkey.value);
}

// 取消
function handleCancel() {
  currentHotkey.value = props.currentValue || '';
  isRecording.value = false;
  pressedKeys.value.clear();
  errorMessage.value = '';
  conflictWarning.value = '';
  emit('cancel');
  emit('update:modelValue', false);
}
</script>

<style scoped>
.custom-hotkey-overlay {
  --hotkey-brand: var(--brand, #ef4776);
  --hotkey-brand-strong: var(--brand-strong, #dc315f);
  --hotkey-brand-soft: var(--brand-soft, #fff0f4);
  --hotkey-ink: var(--ink, #172033);
  --hotkey-muted: var(--muted, #737c8f);
  --hotkey-line: var(--line, #e5e8ef);
  --hotkey-surface: var(--surface, #fff);
  --hotkey-surface-soft: var(--surface-soft, #f7f8fb);
  position: fixed;
  z-index: 3000;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding: 24px;
  background: rgba(23, 32, 51, .3);
  backdrop-filter: blur(8px);
  font-family: inherit;
}

.custom-hotkey-dialog {
  display: flex;
  width: min(560px, 100%);
  max-height: min(760px, calc(100vh - 32px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .8);
  border-radius: 26px;
  outline: none;
  background: var(--hotkey-surface);
  box-shadow: 0 28px 80px rgba(23, 32, 51, .2), 0 8px 24px rgba(23, 32, 51, .08);
}

.dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 28px 30px 22px;
  border-bottom: 1px solid var(--hotkey-line);
  background: linear-gradient(135deg, #fff7f9 0%, var(--hotkey-surface) 68%);
}

.dialog-heading,
.section-heading {
  min-width: 0;
}

.dialog-eyebrow,
.section-eyebrow {
  display: block;
  color: var(--hotkey-brand-strong);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .12em;
  line-height: 1.4;
  text-transform: uppercase;
}

.dialog-heading h2,
.section-heading h3 {
  margin: 5px 0 0;
  color: var(--hotkey-ink);
  letter-spacing: -.03em;
}

.dialog-heading h2 {
  font-size: 25px;
  line-height: 1.25;
}

.dialog-heading p {
  max-width: 410px;
  margin: 8px 0 0;
  color: var(--hotkey-muted);
  font-size: 12px;
  line-height: 1.65;
}

.dialog-close {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  margin: -4px -6px 0 0;
  border: 1px solid transparent;
  border-radius: 11px;
  color: #8c94a3;
  background: transparent;
  cursor: pointer;
  font-size: 26px;
  font-weight: 300;
  line-height: 1;
  transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
}

.dialog-close:hover,
.dialog-close:focus-visible {
  border-color: #f4ced9;
  color: var(--hotkey-brand-strong);
  background: var(--hotkey-brand-soft);
}

.dialog-body {
  display: grid;
  gap: 18px;
  min-height: 0;
  padding: 24px 30px 26px;
  overflow-y: auto;
}

.recording-card {
  display: grid;
  gap: 16px;
  padding: 20px;
  border: 1px solid #f1d6de;
  border-radius: 20px;
  background: linear-gradient(135deg, #fff8fa 0%, var(--hotkey-surface-soft) 100%);
}

.recording-card.is-recording {
  border-color: #f0b4c5;
  box-shadow: 0 0 0 4px rgba(239, 71, 118, .08);
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.section-heading h3 {
  font-size: 15px;
  line-height: 1.4;
}

.state-badge {
  flex: 0 0 auto;
  padding: 5px 9px;
  border-radius: 999px;
  color: #8b93a4;
  background: #eef1f6;
  font-size: 10px;
  font-weight: 750;
  white-space: nowrap;
}

.state-badge.active,
.state-badge.ready {
  color: var(--hotkey-brand-strong);
  background: var(--hotkey-brand-soft);
}

.hotkey-input-field {
  display: flex;
  min-height: 78px;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 14px 18px;
  border: 1px dashed #d4dae5;
  border-radius: 16px;
  color: var(--hotkey-muted);
  background: rgba(255, 255, 255, .86);
  cursor: pointer;
  font: inherit;
  transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, color 160ms ease;
}

.hotkey-input-field:hover {
  border-color: #ef9ab1;
  color: var(--hotkey-brand-strong);
  background: var(--hotkey-surface);
}

.hotkey-input-field:focus-visible {
  border-color: var(--hotkey-brand);
  outline: 3px solid rgba(239, 71, 118, .16);
  outline-offset: 2px;
}

.hotkey-input-field.recording {
  border-style: solid;
  border-color: var(--hotkey-brand);
  color: var(--hotkey-brand-strong);
  background: var(--hotkey-brand-soft);
  box-shadow: 0 0 0 4px rgba(239, 71, 118, .1);
}

.hotkey-input-field.error {
  border-style: solid;
  border-color: #e46b6b;
  color: #bd4545;
  background: #fff6f6;
}

.hotkey-input-field.warning {
  border-style: solid;
  border-color: #e7b24f;
  color: #9c6b12;
  background: #fffaf0;
}

.hotkey-input-field.success {
  border-style: solid;
  border-color: #8bcaa4;
  color: #2c8050;
  background: #f4fbf6;
}

.placeholder {
  font-size: 13px;
}

.recording-text {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 650;
}

.recording-icon {
  animation: hotkey-spin 1s linear infinite;
}

@keyframes hotkey-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.hotkey-display kbd,
.preset-button kbd {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid #dfe4ed;
  border-bottom-width: 2px;
  border-radius: 9px;
  color: var(--hotkey-ink);
  background: var(--hotkey-surface);
  box-shadow: 0 2px 3px rgba(23, 32, 51, .06);
  font-family: 'SFMono-Regular', 'SF Mono', 'Cascadia Code', 'Roboto Mono', monospace;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: .02em;
}

.hotkey-display kbd {
  padding: 8px 15px;
  border-color: #f0b4c5;
  color: var(--hotkey-brand-strong);
  background: var(--hotkey-brand-soft);
  font-size: 17px;
}

.field-hint,
.section-note {
  color: var(--hotkey-muted);
  font-size: 11px;
  line-height: 1.55;
}

.field-hint {
  margin: -4px 0 0;
}

.section-note {
  padding-top: 2px;
  white-space: nowrap;
}

.hotkey-status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 13px;
  font-size: 12px;
  line-height: 1.5;
}

.hotkey-status.error {
  border-color: #f1c2c2;
  color: #b84d4d;
  background: #fff6f6;
}

.hotkey-status.warning {
  border-color: #f0d49a;
  color: #956713;
  background: #fffaf0;
}

.hotkey-status.success {
  border-color: #b9e0c5;
  color: #2d7d4d;
  background: #f4fbf6;
}

.preset-section {
  display: grid;
  gap: 13px;
}

.preset-buttons {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.preset-button {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px 9px 12px;
  border: 1px solid var(--hotkey-line);
  border-radius: 14px;
  color: var(--hotkey-muted);
  background: var(--hotkey-surface);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: border-color 160ms ease, color 160ms ease, background 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}

.preset-button:hover,
.preset-button:focus-visible {
  border-color: #ef9ab1;
  color: var(--hotkey-brand-strong);
  background: #fffafb;
  box-shadow: 0 7px 18px rgba(239, 71, 118, .08);
  transform: translateY(-1px);
}

.preset-button.selected {
  border-color: #f0b4c5;
  color: var(--hotkey-brand-strong);
  background: var(--hotkey-brand-soft);
  box-shadow: 0 6px 16px rgba(239, 71, 118, .08);
}

.preset-button kbd {
  flex: 0 0 auto;
  color: var(--hotkey-ink);
  font-size: 12px;
}

.preset-button.selected kbd {
  border-color: #f0b4c5;
  color: var(--hotkey-brand-strong);
}

.preset-label {
  overflow: hidden;
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.help-section {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 13px 14px;
  border: 1px solid var(--hotkey-line);
  border-radius: 14px;
  background: var(--hotkey-surface-soft);
}

.help-icon {
  display: grid;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  place-items: center;
  margin-top: 1px;
  border-radius: 50%;
  color: var(--hotkey-brand-strong);
  background: var(--hotkey-brand-soft);
  font-size: 11px;
  font-weight: 800;
}

.help-section p {
  margin: 0;
  color: var(--hotkey-muted);
  font-size: 11px;
  line-height: 1.65;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 30px 24px;
  border-top: 1px solid var(--hotkey-line);
  background: var(--hotkey-surface);
}

.dialog-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-left: auto;
}

.clear-button,
.secondary-button,
.primary-button {
  min-height: 40px;
  padding: 0 16px;
  border-radius: 12px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  transition: border-color 160ms ease, color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.clear-button {
  padding: 0;
  border: 0;
  color: #bd656d;
  background: transparent;
}

.clear-button:hover,
.clear-button:focus-visible {
  color: #a64852;
  text-decoration: underline;
}

.secondary-button {
  border: 1px solid var(--hotkey-line);
  color: var(--hotkey-ink);
  background: var(--hotkey-surface);
}

.secondary-button:hover,
.secondary-button:focus-visible {
  border-color: #ccd3df;
  background: var(--hotkey-surface-soft);
}

.primary-button {
  border: 1px solid var(--hotkey-brand);
  color: #fff;
  background: var(--hotkey-brand);
  box-shadow: 0 7px 16px rgba(239, 71, 118, .2);
}

.primary-button:hover:not(:disabled),
.primary-button:focus-visible:not(:disabled) {
  border-color: var(--hotkey-brand-strong);
  background: var(--hotkey-brand-strong);
  box-shadow: 0 9px 20px rgba(239, 71, 118, .25);
  transform: translateY(-1px);
}

.primary-button:disabled {
  border-color: #dfe4ed;
  color: #aeb5c1;
  background: #eef1f5;
  box-shadow: none;
  cursor: not-allowed;
}

:global(.dark) .custom-hotkey-overlay {
  --hotkey-brand-soft: rgba(239, 71, 118, .16);
  --hotkey-ink: #f4f6fb;
  --hotkey-muted: #aeb6c5;
  --hotkey-line: #353c49;
  --hotkey-surface: #171b23;
  --hotkey-surface-soft: #202630;
  background: rgba(5, 7, 11, .62);
}

:global(.dark) .custom-hotkey-dialog {
  border-color: #353c49;
  box-shadow: 0 28px 80px rgba(0, 0, 0, .55);
}

:global(.dark) .dialog-header,
:global(.dark) .recording-card {
  border-color: #44313a;
  background: linear-gradient(135deg, #261b22 0%, var(--hotkey-surface) 72%);
}

:global(.dark) .hotkey-input-field {
  border-color: #4a5260;
  background: #1d222b;
}

:global(.dark) .state-badge,
:global(.dark) .primary-button:disabled {
  color: #aeb6c5;
  background: #2a303a;
}

:global(.dark) .hotkey-input-field.error,
:global(.dark) .hotkey-status.error {
  border-color: #8f4d55;
  color: #ffb5bd;
  background: #321d21;
}

:global(.dark) .hotkey-input-field.warning,
:global(.dark) .hotkey-status.warning {
  border-color: #87672f;
  color: #f2cc83;
  background: #302718;
}

:global(.dark) .hotkey-input-field.success,
:global(.dark) .hotkey-status.success {
  border-color: #46775b;
  color: #9ee2b7;
  background: #193025;
}

:global(.dark) .preset-button:hover,
:global(.dark) .preset-button:focus-visible {
  background: #291d23;
}

@media (max-width: 560px) {
  .custom-hotkey-overlay {
    align-items: flex-start;
    padding: 14px;
  }

  .custom-hotkey-dialog {
    max-height: calc(100vh - 28px);
    border-radius: 21px;
  }

  .dialog-header {
    padding: 22px 20px 18px;
  }

  .dialog-heading h2 {
    font-size: 22px;
  }

  .dialog-body {
    padding: 18px 20px 20px;
  }

  .recording-card {
    padding: 16px;
  }

  .preset-buttons {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dialog-footer {
    padding: 15px 20px 19px;
  }
}

@media (max-width: 380px) {
  .custom-hotkey-overlay {
    padding: 8px;
  }

  .custom-hotkey-dialog {
    max-height: calc(100vh - 16px);
  }

  .dialog-header,
  .dialog-body,
  .dialog-footer {
    padding-right: 15px;
    padding-left: 15px;
  }

  .recording-card {
    padding: 13px;
  }

  .section-note {
    display: none;
  }

  .dialog-footer {
    align-items: stretch;
    flex-direction: column-reverse;
  }

  .dialog-actions {
    width: 100%;
  }

  .secondary-button,
  .primary-button {
    flex: 1 1 0;
  }

  .clear-button {
    align-self: flex-start;
  }
}
</style>
