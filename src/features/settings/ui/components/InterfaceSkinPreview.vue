<!--
@file src/features/settings/ui/components/InterfaceSkinPreview.vue
文件职责：在弹窗皮肤展台左侧渲染粘性 1:1 实时 Popup 舞台，提供明暗预览切换、当前应用/悬停预览状态指示、属性标签与无障碍播报。
主要内容：顶部控制条显示正在预览的皮肤名、状态徽标与紧凑 3 态明暗预览开关（跟随/浅色/深色，专属深色皮肤自动锁定深色并提示）；中央使用随极性自适应的点阵画布居中托起 `.popup-skin-scope` 隔离的 `PopupPreview`，避免皮肤样式外泄至设置页本体；底部展示当前皮肤说明及宽度、明暗适应、风格标签。
模块边界：本组件仅承载展示与预览明暗模式切换事件，不直接读写用户配置、不修改全局主题或连接浏览器存储。
-->
<template>
  <aside class="popup-skin-stage" aria-labelledby="skin-stage-title">
    <header class="skin-stage-bar">
      <div class="skin-stage-identity">
        <strong id="skin-stage-title">{{ skinLabel }}</strong>
        <span class="skin-stage-status" :class="{ 'is-previewing': previewing }">
          <i aria-hidden="true" />
          {{ previewing ? t('settings.interface.skinStudio.previewing') : t('settings.interface.skinStudio.applied') }}
        </span>
      </div>
      <div
        class="skin-stage-theme-switch"
        role="radiogroup"
        :aria-label="t('settings.interface.skinStudio.previewTheme')"
        :title="isDarkOnly ? t('settings.interface.skinStudio.darkOnlyHint') : undefined"
        @keydown="handleThemeKeydown"
      >
        <button
          type="button"
          role="radio"
          :aria-checked="!isDarkOnly && themeMode === 'auto'"
          :tabindex="!isDarkOnly && themeMode === 'auto' ? 0 : -1"
          :disabled="isDarkOnly"
          :aria-label="t('settings.interface.skinStudio.themeAuto')"
          :title="isDarkOnly ? t('settings.interface.skinStudio.darkOnlyHint') : t('settings.interface.skinStudio.themeAuto')"
          data-preview-theme-btn="auto"
          @click="!isDarkOnly && emit('update:themeMode', 'auto')"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="8.5" rx="1.5" />
            <path d="M5.5 13.5h5M8 11v2.5" />
          </svg>
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="!isDarkOnly && themeMode === 'light'"
          :tabindex="!isDarkOnly && themeMode === 'light' ? 0 : -1"
          :disabled="isDarkOnly"
          :aria-label="t('settings.interface.skinStudio.themeLight')"
          :title="isDarkOnly ? t('settings.interface.skinStudio.darkOnlyHint') : t('settings.interface.skinStudio.themeLight')"
          data-preview-theme-btn="light"
          @click="!isDarkOnly && emit('update:themeMode', 'light')"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06" />
          </svg>
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="isDarkOnly || themeMode === 'dark'"
          :tabindex="isDarkOnly || themeMode === 'dark' ? 0 : -1"
          :aria-label="t('settings.interface.skinStudio.themeDark')"
          :title="t('settings.interface.skinStudio.themeDark')"
          data-preview-theme-btn="dark"
          @click="!isDarkOnly && emit('update:themeMode', 'dark')"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13.2 9.8A5.4 5.4 0 0 1 6.2 2.8a5.6 5.6 0 1 0 7 7Z" />
          </svg>
        </button>
      </div>
    </header>

    <div class="skin-stage-canvas" :data-stage-polarity="effectiveTheme" :data-stage-style="skin.preview.cardStyle">
      <section
        class="interface-skin-live-preview popup-skin-scope"
        :data-interface-skin="skin.value"
        :data-interface-skin-kind="skin.kind"
        :data-preview-skin="skin.value"
        :data-preview-kind="skin.kind"
        :data-popup-theme="effectiveTheme"
        :style="{'--interface-popup-width': `${skin.popupWidth}px`}"
        role="img"
        :aria-label="previewLabel"
      >
        <PopupPreview :skin="skin" aria-hidden="true" />
      </section>
    </div>

    <footer class="skin-stage-meta">
      <p class="skin-stage-description">{{ skinDescription }}</p>
      <div class="skin-stage-chips">
        <span class="skin-stage-chip is-mono">{{ skin.popupWidth }}px</span>
        <span class="skin-stage-chip">
          {{ isDarkOnly ? t('settings.interface.skinStudio.darkOnly') : t('settings.interface.skinStudio.adaptiveTheme') }}
        </span>
        <span class="skin-stage-chip">{{ translateLegacy(skin.badge) }}</span>
      </div>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import type {InterfaceSkinOption} from '@/src/core/config/interfaceAppearance'
import {useUiI18n} from '@/src/ui/i18n'
import PopupPreview from './PopupPreview.vue'

export type SkinPreviewThemeMode = 'auto' | 'light' | 'dark'

const props = withDefaults(defineProps<{
  skin: InterfaceSkinOption
  previewLabel: string
  themeMode?: SkinPreviewThemeMode
  appDark?: boolean
  previewing?: boolean
}>(), {
  themeMode: 'auto',
  appDark: false,
  previewing: false,
})

const emit = defineEmits<{
  'update:themeMode': [mode: SkinPreviewThemeMode]
}>()

const {t, translateLegacy} = useUiI18n()
const isDarkOnly = computed(() => props.skin.toneMode === 'dark')
const effectiveTheme = computed<'light' | 'dark'>(() => {
  if (isDarkOnly.value) return 'dark'
  if (props.themeMode === 'auto') return props.appDark ? 'dark' : 'light'
  return props.themeMode
})
const skinLabel = computed(() => translateLegacy(props.skin.label))
const skinDescription = computed(() => translateLegacy(props.skin.description).replace('FluentRead', t('common.brand')))
const themeModes: readonly SkinPreviewThemeMode[] = ['auto', 'light', 'dark']

function handleThemeKeydown(event: KeyboardEvent): void {
  if (isDarkOnly.value || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = Math.max(0, themeModes.indexOf(props.themeMode))
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? themeModes.length - 1
      : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + themeModes.length) % themeModes.length
  const nextMode = themeModes[next]
  emit('update:themeMode', nextMode)
  const target = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLButtonElement>(`[data-preview-theme-btn="${nextMode}"]`)
  target?.focus()
}
</script>

<style scoped>
.popup-skin-stage {
  position: sticky;
  top: 12px;
  display: grid;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--fr-radius-lg, 12px);
  background: var(--surface);
}

.skin-stage-bar {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.skin-stage-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.skin-stage-identity strong {
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fr-text-base, 13px);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skin-stage-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--fr-radius-full, 9999px);
  color: var(--muted);
  background: var(--surface-soft);
  font-size: var(--fr-text-xs, 11px);
  font-weight: 600;
  white-space: nowrap;
}

.skin-stage-status > i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fr-success-indicator, #24b47e);
}

.skin-stage-status.is-previewing {
  color: var(--brand-strong);
  background: var(--brand-soft);
}

.skin-stage-status.is-previewing > i {
  background: var(--brand);
}

.skin-stage-theme-switch {
  display: inline-grid;
  flex: none;
  grid-auto-flow: column;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: var(--fr-control-radius, 8px);
  background: var(--surface-soft);
}

.skin-stage-theme-switch button {
  display: grid;
  width: 28px;
  height: 24px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition: color 120ms var(--fr-ease-out, ease), background-color 120ms var(--fr-ease-out, ease);
}

.skin-stage-theme-switch button svg {
  width: 14px;
  height: 14px;
}

.skin-stage-theme-switch button:hover:not(:disabled) {
  color: var(--ink);
}

.skin-stage-theme-switch button[aria-checked="true"] {
  color: var(--brand-strong);
  background: var(--surface);
  box-shadow: var(--fr-shadow-xs);
}

.skin-stage-theme-switch button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.skin-stage-theme-switch button:focus-visible {
  outline: 2px solid var(--brand-strong);
  outline-offset: 1px;
}

.skin-stage-canvas {
  display: grid;
  min-height: 468px;
  padding: 20px 16px;
  place-items: center;
  background-color: #eceff4;
  background-image: radial-gradient(circle, rgba(23, 32, 51, 0.14) 1px, transparent 1px);
  background-size: 14px 14px;
  transition: background-color 180ms var(--fr-ease-out, ease);
}

.skin-stage-canvas[data-stage-polarity="dark"] {
  background-color: #0d1017;
  background-image: radial-gradient(circle, rgba(255, 255, 255, 0.10) 1px, transparent 1px);
}

.skin-stage-canvas[data-stage-style="liquid-glass"] {
  background:
    radial-gradient(circle at 18% 18%, rgba(56, 189, 248, 0.34), transparent 50%),
    radial-gradient(circle at 82% 24%, rgba(168, 85, 247, 0.28), transparent 50%),
    #e2ecf8;
}

.skin-stage-canvas[data-stage-style="liquid-glass"][data-stage-polarity="dark"] {
  background:
    radial-gradient(circle at 18% 18%, rgba(56, 189, 248, 0.22), transparent 50%),
    radial-gradient(circle at 82% 24%, rgba(129, 140, 248, 0.24), transparent 50%),
    #070d19;
}

.skin-stage-canvas[data-stage-style="brutalist"] {
  background-color: #f7e694;
  background-image: radial-gradient(circle, rgba(17, 17, 17, 0.18) 1px, transparent 1px);
}

.skin-stage-canvas[data-stage-style="brutalist"][data-stage-polarity="dark"] {
  background-color: #121115;
  background-image: radial-gradient(circle, rgba(255, 222, 56, 0.18) 1px, transparent 1px);
}

.skin-stage-canvas[data-stage-style="retro-os"] {
  background: #007575;
}

.skin-stage-canvas[data-stage-style="retro-os"][data-stage-polarity="dark"] {
  background: #122d30;
}

.skin-stage-canvas[data-stage-style="cyber"] {
  background-color: #050510;
  background-image:
    linear-gradient(rgba(0, 229, 255, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.08) 1px, transparent 1px);
  background-size: 18px 18px;
}

.skin-stage-canvas[data-stage-style="terminal"] {
  background: repeating-linear-gradient(0deg, rgba(34, 197, 94, 0.06) 0 1px, transparent 1px 3px), #040806;
}

.skin-stage-canvas[data-stage-style="midnight-gold"] {
  background: radial-gradient(circle at 50% 0%, rgba(212, 175, 55, 0.18), transparent 65%), #070609;
}

.skin-stage-canvas[data-stage-style="swiss-minimal"] {
  background-color: #f4f5f7;
  background-image: none;
}

.skin-stage-canvas[data-stage-style="swiss-minimal"][data-stage-polarity="dark"] {
  background-color: #08090c;
  background-image: none;
}

.skin-stage-canvas[data-stage-style="golden-hour"] {
  background:
    radial-gradient(circle at 84% 12%, rgba(251, 146, 60, 0.34), transparent 50%),
    radial-gradient(circle at 16% 86%, rgba(244, 63, 94, 0.24), transparent 52%),
    #fce9d8;
}

.skin-stage-canvas[data-stage-style="golden-hour"][data-stage-polarity="dark"] {
  background:
    radial-gradient(circle at 84% 10%, rgba(249, 115, 22, 0.24), transparent 52%),
    radial-gradient(circle at 16% 88%, rgba(225, 29, 72, 0.20), transparent 52%),
    #0f090c;
}

.skin-stage-canvas[data-stage-style="blueprint"] {
  background-color: #04142b;
  background-image:
    linear-gradient(rgba(186, 230, 253, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(186, 230, 253, 0.12) 1px, transparent 1px);
  background-size: 20px 20px;
}

.skin-stage-canvas[data-stage-style="starlight"] {
  background:
    radial-gradient(1.5px 1.5px at 20% 22%, rgba(255, 255, 255, 0.72) 50%, transparent 100%),
    radial-gradient(1.2px 1.2px at 80% 18%, rgba(196, 181, 253, 0.75) 50%, transparent 100%),
    radial-gradient(1.4px 1.4px at 74% 82%, rgba(253, 230, 138, 0.72) 50%, transparent 100%),
    radial-gradient(circle at 24% 12%, rgba(99, 102, 241, 0.26), transparent 52%),
    radial-gradient(circle at 82% 88%, rgba(139, 92, 246, 0.22), transparent 52%),
    #050714;
}

/* 与真实菜单栏同宽：窄版跟随皮肤登记的宽度，拉丁字母与西里尔字母语言沿用菜单栏的加宽规则。 */
.interface-skin-live-preview {
  --preview-popup-width: var(--interface-popup-width, 320px);
  width: var(--preview-popup-width);
  max-width: 100%;
  transition: width 180ms var(--fr-ease-out, ease);
}

.interface-skin-live-preview :deep(.preview-popup) {
  box-shadow: 0 0 0 var(--skin-border-width, 1px) var(--line), 0 14px 34px -14px rgba(15, 23, 42, 0.24), 0 2px 6px rgba(15, 23, 42, 0.06);
}

.skin-stage-canvas[data-stage-polarity="dark"] .interface-skin-live-preview :deep(.preview-popup) {
  box-shadow: 0 0 0 var(--skin-border-width, 1px) var(--line), 0 18px 42px -14px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
}

:root:is(:lang(en), :lang(fr), :lang(ru), :lang(es)) .interface-skin-live-preview:not([data-preview-kind="default"]) {
  --preview-popup-width: max(var(--interface-popup-width, 320px), 380px);
}

.skin-stage-meta {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.skin-stage-description {
  margin: 0;
  color: var(--muted);
  font-size: var(--fr-text-sm, 12px);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.skin-stage-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.skin-stage-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--fr-radius-xs, 6px);
  color: var(--muted);
  background: var(--surface-soft);
  font-size: var(--fr-text-xs, 11px);
  font-weight: 500;
}

.skin-stage-chip.is-mono {
  font-family: var(--fr-font-mono);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1080px) {
  .skin-stage-canvas { padding: 14px 12px; }
}

@media (max-width: 820px) {
  .popup-skin-stage { position: static; }
  .skin-stage-canvas { min-height: 452px; padding: 16px 12px; }
}

@media (max-width: 820px) and (any-pointer: coarse) {
  .skin-stage-canvas { min-height: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .skin-stage-canvas,
  .interface-skin-live-preview,
  .skin-stage-theme-switch button {
    transition: none;
  }
}
</style>
