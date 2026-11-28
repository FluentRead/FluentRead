<!--
 * @file src/features/command-palette/ui/CommandPalette.vue
 * 文件职责：在封闭 Shadow DOM 中渲染全局命令面板对话框，提供实时搜索过滤、键盘导航、分组展示与动作执行反馈。
 * 主要内容：遵循 Calm Reading 语义设计令牌与无障碍对话框规范（dialog/combobox/listbox），支持上下方向键、Home/End、Enter 与 Esc 操作，关闭时自动归还打开前的页面焦点，并隔离宿主页面点击与滚轮事件。
 * 模块边界：组件不直接调用翻译或导航服务，也不持久化配置；所有命令目录与动作执行均通过运行时传入的回调和快照驱动。
-->
<template>
  <div
    v-if="opened"
    class="fr-palette-backdrop"
    :lang="language"
    data-testid="command-palette-backdrop"
    @pointerdown.stop
    @click.self="close"
    @wheel.stop.passive
  >
    <div
      class="fr-palette-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fr-command-palette-title"
      data-testid="command-palette-dialog"
      @keydown.stop="handleKeydown"
      @keyup.stop
      @keypress.stop
      @click.stop
    >
      <header class="fr-palette-header">
        <span id="fr-command-palette-title" class="fr-palette-sr-only">{{ t('commandPalette.title') }}</span>
        <span class="fr-palette-search-icon" aria-hidden="true">⌘</span>
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          class="fr-palette-input"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="fr-command-palette-listbox"
          :aria-activedescendant="activeOptionId"
          :aria-label="t('commandPalette.searchPlaceholder')"
          :placeholder="t('commandPalette.searchPlaceholder')"
          spellcheck="false"
          autocomplete="off"
          data-testid="command-palette-input"
        />
        <kbd v-if="shortcutHint" class="fr-palette-kbd">{{ shortcutHint }}</kbd>
        <button
          type="button"
          class="fr-palette-close"
          :aria-label="t('common.close')"
          data-testid="command-palette-close"
          @click="close"
        >
          ×
        </button>
      </header>

      <div
        id="fr-command-palette-listbox"
        class="fr-palette-list"
        role="listbox"
        :aria-label="t('commandPalette.listLabel')"
        data-testid="command-palette-listbox"
      >
        <template v-if="projection.groups.length > 0">
          <section v-for="group in projection.groups" :key="group.category" class="fr-palette-group">
            <div class="fr-palette-group-label">{{ t(`commandPalette.category.${group.category}`) }}</div>
            <button
              v-for="item in group.items"
              :id="`fr-cmd-opt-${item.id}`"
              :key="item.id"
              type="button"
              role="option"
              class="fr-palette-option"
              :class="{ 'is-active': activeId === item.id }"
              :aria-selected="activeId === item.id"
              :data-command-id="item.id"
              @mouseenter="setActiveById(item.id)"
              @click="executeItem(item)"
            >
              <span class="fr-palette-option-main">
                <span class="fr-palette-option-title">{{ item.title }}</span>
                <span class="fr-palette-option-desc">{{ item.description }}</span>
              </span>
              <span class="fr-palette-option-meta">
                <span v-if="item.badge" class="fr-palette-badge">{{ item.badge }}</span>
                <kbd v-if="item.shortcut" class="fr-palette-kbd">{{ item.shortcut }}</kbd>
              </span>
            </button>
          </section>
        </template>
        <p v-else class="fr-palette-empty" role="status" data-testid="command-palette-empty">
          {{ t('commandPalette.empty') }}
        </p>
      </div>

      <footer class="fr-palette-footer">
        <span>{{ t('commandPalette.footerHint') }}</span>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import {
    filterAndGroupCommands,
    resolvePaletteKeyAction,
    type CommandPaletteActionId,
    type CommandPaletteItem,
} from '../core';

export interface CommandPaletteOpenPayload {
    readonly commands: readonly CommandPaletteItem[];
    readonly recentIds: readonly CommandPaletteActionId[];
    readonly shortcutHint: string;
    readonly onExecute: (id: CommandPaletteActionId) => void | Promise<void>;
}

const {t, language} = useUiI18n();
const opened = ref(false);
const query = ref('');
const activeIndex = ref(0);
const commands = ref<readonly CommandPaletteItem[]>([]);
const recentIds = ref<readonly CommandPaletteActionId[]>([]);
const shortcutHint = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
let executeHandler: ((id: CommandPaletteActionId) => void | Promise<void>) | null = null;
let previousFocused: HTMLElement | null = null;

const projection = computed(() => filterAndGroupCommands(commands.value, query.value, recentIds.value));
const activeItem = computed(() => projection.value.flatItems[activeIndex.value]);
const activeId = computed(() => activeItem.value?.id ?? '');
const activeOptionId = computed(() => activeId.value ? `fr-cmd-opt-${activeId.value}` : undefined);

watch(() => projection.value.flatItems.length, (count) => {
    if (count === 0) activeIndex.value = -1;
    else if (activeIndex.value < 0 || activeIndex.value >= count) activeIndex.value = 0;
});

watch(query, () => {
    activeIndex.value = projection.value.flatItems.length > 0 ? 0 : -1;
});

function restoreFocus(): void {
    const target = previousFocused;
    previousFocused = null;
    if (target && target.isConnected && typeof target.focus === 'function') {
        try {
            target.focus({preventScroll: true});
        } catch {
            target.focus();
        }
    }
}

function setActiveById(id: CommandPaletteActionId): void {
    activeIndex.value = Math.max(0, projection.value.flatItems.findIndex((item) => item.id === id));
}

function open(payload: CommandPaletteOpenPayload): void {
    if (!opened.value) {
        previousFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    commands.value = payload.commands;
    recentIds.value = payload.recentIds;
    shortcutHint.value = payload.shortcutHint;
    executeHandler = payload.onExecute;
    query.value = '';
    opened.value = true;
    activeIndex.value = projection.value.flatItems.length > 0 ? 0 : -1;
    void nextTick(() => {
        if (!opened.value) return;
        inputRef.value?.focus({preventScroll: true});
    });
}

function close(): void {
    if (!opened.value) return;
    opened.value = false;
    query.value = '';
    executeHandler = null;
    restoreFocus();
}

function executeItem(item: CommandPaletteItem): void {
    const handler = executeHandler;
    close();
    void Promise.resolve(handler!(item.id)).catch(() => undefined);
}

function handleKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    const action = resolvePaletteKeyAction(event.key, activeIndex.value, projection.value.flatItems.length);
    if (action.type === 'noop') return;
    event.preventDefault();
    if (action.type === 'close') {
        close();
        return;
    }
    if (action.type === 'move') {
        activeIndex.value = action.nextIndex;
        return;
    }
    executeItem(projection.value.flatItems[action.index]);
}

onBeforeUnmount(() => {
    opened.value = false;
    executeHandler = null;
    previousFocused = null;
});

defineExpose({
    open,
    close,
    isOpen: () => opened.value,
});
</script>

<style scoped>
.fr-palette-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: min(14vh, 112px) 16px 24px;
  background: rgba(15, 23, 42, 0.36);
  backdrop-filter: blur(4px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans TC", "Microsoft YaHei", sans-serif;
}

.fr-palette-dialog {
  width: min(560px, 100%);
  max-height: min(72vh, 540px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--fr-border-subtle, #e2e8f0);
  background: var(--fr-surface-elevated, #ffffff);
  color: var(--fr-text-primary, #172033);
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22);
}

.fr-palette-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--fr-border-subtle, #e5e7eb);
}

.fr-palette-search-icon {
  color: var(--fr-text-muted, #64748b);
  font-size: 14px;
  flex-shrink: 0;
}

.fr-palette-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 1.5;
}

.fr-palette-close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fr-text-muted, #64748b);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.fr-palette-close:hover {
  background: var(--fr-surface-soft, #f1f5f9);
  color: var(--fr-text-primary, #172033);
}

.fr-palette-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  overscroll-behavior: contain;
}

.fr-palette-group + .fr-palette-group {
  margin-top: 8px;
}

.fr-palette-group-label {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fr-text-muted, #64748b);
  letter-spacing: 0.02em;
}

.fr-palette-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.fr-palette-option.is-active {
  background: var(--fr-brand-soft, #eef4ff);
  border-color: var(--fr-brand-border, #c7dbff);
}

.fr-palette-option-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.fr-palette-option-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fr-text-primary, #172033);
}

.fr-palette-option-desc {
  font-size: 12px;
  color: var(--fr-text-muted, #64748b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fr-palette-option-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.fr-palette-badge {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--fr-surface-soft, #f1f5f9);
  color: var(--fr-text-secondary, #475569);
  font-size: 11px;
  font-weight: 500;
}

.fr-palette-kbd {
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--fr-border-subtle, #dbe2ea);
  background: var(--fr-surface-soft, #f8fafc);
  color: var(--fr-text-secondary, #475569);
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.fr-palette-empty {
  margin: 24px 12px;
  text-align: center;
  color: var(--fr-text-muted, #64748b);
  font-size: 13px;
}

.fr-palette-footer {
  padding: 8px 14px;
  border-top: 1px solid var(--fr-border-subtle, #e5e7eb);
  color: var(--fr-text-muted, #64748b);
  font-size: 11px;
}

.fr-palette-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-color-scheme: dark) {
  .fr-palette-dialog {
    background: var(--fr-surface-elevated, #151b26);
    border-color: var(--fr-border-subtle, #293245);
    color: var(--fr-text-primary, #e6edf7);
  }
  .fr-palette-header,
  .fr-palette-footer {
    border-color: var(--fr-border-subtle, #293245);
  }
  .fr-palette-option.is-active {
    background: var(--fr-brand-soft, rgba(59, 130, 246, 0.18));
    border-color: var(--fr-brand-border, rgba(96, 165, 250, 0.4));
  }
  .fr-palette-option-title {
    color: var(--fr-text-primary, #e6edf7);
  }
  .fr-palette-option-desc,
  .fr-palette-group-label,
  .fr-palette-footer,
  .fr-palette-empty {
    color: var(--fr-text-muted, #94a3b8);
  }
  .fr-palette-badge,
  .fr-palette-kbd {
    background: var(--fr-surface-soft, #1f2937);
    border-color: var(--fr-border-subtle, #334155);
    color: var(--fr-text-secondary, #cbd5e1);
  }
}
</style>
