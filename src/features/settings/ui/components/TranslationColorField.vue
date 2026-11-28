<!--
@file src/features/settings/ui/components/TranslationColorField.vue
文件职责：为译文颜色、独立背景、线条颜色和标记底色提供统一的色板选择行，支持“默认”、精选色、取色器和精确输入。
主要内容：以 radiogroup 语义渲染默认选项与色块，支持方向键、Home、End 的漫游焦点；选中色板以外的颜色时点亮彩虹取色器并显示该色，
取色器和颜色名、RGB、十六进制输入统一归一为小写六位十六进制，非法输入留在编辑框并显示错误，不写入配置；取色器菜单保留在原 Shadow Root，内部已有焦点时取消厂商误判触发的初始焦点遍历；仅保留最后一次待聚焦帧，先登记帧再发出选择，仅在控件仍连接、原焦点归属与颜色有效时同步焦点，色板替换、缓存停用与卸载时取消；仅为本取色器子树提供局部按钮语言与英语描述 fallback，不改父级 vendor 语言或全局配置。
模块边界：只通过 v-model 发出颜色字符串，不读写配置，也不决定颜色如何作用到网页；色板与归一化规则来自 core/config/translationAppearance。
-->
<template>
  <div class="translation-color-field" :data-color-field="fieldId">
    <div class="translation-color-copy">
      <strong :id="`${fieldId}-label`">{{ label }}</strong>
      <small v-if="hint">{{ hint }}</small>
    </div>
    <div class="translation-color-options">
      <div ref="groupElement" class="translation-color-choices" role="radiogroup" :aria-labelledby="`${fieldId}-label`">
        <button
          type="button"
          role="radio"
          class="translation-color-default"
          :class="{ selected: !modelValue }"
          :aria-checked="!modelValue"
          :tabindex="focusIndex === 0 ? 0 : -1"
          data-choice-index="0"
          @click="select('')"
          @keydown="handleKeydown($event, 0)"
        >
          {{ t('settings.translationStyle.colorDefault') }}
        </button>
        <button
          v-for="(swatch, index) in swatches"
          :key="swatch.id"
          type="button"
          role="radio"
          class="translation-color-swatch"
          :class="{ selected: modelValue === swatch.value }"
          :style="{ '--translation-swatch': swatch.value }"
          :aria-checked="modelValue === swatch.value"
          :aria-label="t(swatch.labelKey)"
          :title="t(swatch.labelKey)"
          :tabindex="focusIndex === index + 1 ? 0 : -1"
          :data-choice-index="index + 1"
          :data-color="swatch.value"
          @click="select(swatch.value)"
          @keydown="handleKeydown($event, index + 1)"
        ><i aria-hidden="true" /></button>
      </div>
      <span ref="customElement" class="translation-color-custom" :class="{ selected: isCustom }" :title="t('settings.translationStyle.customColor')">
        <PickerLocale>
          <ElColorPicker
            :model-value="isCustom ? modelValue : undefined"
            :teleported="teleported"
            size="small"
            :aria-label="t('settings.translationStyle.customColor')"
            @update:model-value="select"
          />
        </PickerLocale>
      </span>
    </div>
    <input
      v-model="colorDraft"
      class="translation-color-value"
      type="text"
      :aria-label="`${label} · ${t('settings.translationStyle.customColor')}`"
      :aria-invalid="invalidColor"
      :aria-describedby="invalidColor ? `${fieldId}-error` : undefined"
      placeholder="red / rgb(255, 0, 0) / #ff0000"
      autocomplete="off"
      spellcheck="false"
      @blur="commitColorDraft"
      @keydown.enter.prevent="commitColorDraft"
    >
    <small v-if="invalidColor" :id="`${fieldId}-error`" class="translation-color-error" role="alert">{{ t('settings.translationStyle.colorInvalid') }}</small>
  </div>
</template>

<script setup lang="ts">
import {computed, defineComponent, onActivated, onBeforeUnmount, onDeactivated, onMounted, provide, ref, watch} from 'vue'
import {localeContextKey, useLocale} from 'element-plus'
import {FOCUS_AFTER_TRAPPED} from 'element-plus/es/components/focus-trap/index'
import English from 'element-plus/es/locale/lang/en'
import type {Language, TranslatePair} from 'element-plus/es/locale'
import type {UiLanguage} from '@/src/core/i18n/language'
import {normalizeTranslationColor, type TranslationColorSwatch} from '@/src/core/config/translationAppearance'
import {useUiI18n} from '@/src/ui/i18n'
import {ShadowColorPicker as ElColorPicker} from '@/src/ui/shadowColorPicker'

const props = defineProps<{
  modelValue: string
  label: string
  fieldId: string
  swatches: readonly TranslationColorSwatch[]
  hint?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const {t, language} = useUiI18n()
const {locale: inheritedVendorLocale} = useLocale()
// 锁版本公开词条适配；只覆盖当前取色器两项，不改变父级或全局 vendor 配置。
const pickerClearLabels = {
  'zh-CN': '清空',
  'zh-TW': '清空',
  'en-US': 'Clear',
  'ja-JP': 'クリア',
  'ko-KR': '초기화',
  'fr-FR': 'Effacer',
  'ru-RU': 'Очистить',
  'es-ES': 'Despejar',
} as const satisfies Readonly<Record<UiLanguage, string>>
const pickerLocale = computed<Language>(() => {
  const inherited = inheritedVendorLocale.value
  const section = inherited.el.colorpicker
  return {...inherited, name: language.value, el: {...inherited.el, colorpicker: {
    ...(English.el.colorpicker as TranslatePair),
    ...(section && typeof section === 'object' && !Array.isArray(section) ? section : {}),
    confirm: t('common.confirm'), clear: pickerClearLabels[language.value],
  }}}
})
const PickerLocale = defineComponent({
  setup(_, {slots}) {
    provide(localeContextKey, pickerLocale)
    return () => slots.default!()
  },
})
const groupElement = ref<HTMLElement | null>(null)
const customElement = ref<HTMLElement | null>(null)
const teleported = ref(false)
let focusGuardElement: HTMLElement | null = null
function retainPickerFocus(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const root = target.getRootNode()
  // 厂商 document.activeElement 在闭合 Shadow Root 中只能看到 host。
  // 只取消当前菜单已有内部焦点时的默认遍历，不抢焦点或阻止事件传播。
  if (root instanceof ShadowRoot && target.contains(root.activeElement)) event.preventDefault()
}
function startPickerFocusGuard(): void {
  if (focusGuardElement) return
  focusGuardElement = customElement.value!
  focusGuardElement.addEventListener(FOCUS_AFTER_TRAPPED, retainPickerFocus, true)
}
function stopPickerFocusGuard(): void {
  if (!focusGuardElement) return
  focusGuardElement.removeEventListener(FOCUS_AFTER_TRAPPED, retainPickerFocus, true)
  focusGuardElement = null
}
onMounted(() => {
  teleported.value = !(groupElement.value?.getRootNode() instanceof ShadowRoot)
  startPickerFocusGuard()
})
onActivated(startPickerFocusGuard)
const colorDraft = ref(props.modelValue)
const invalidColor = ref(false)
let pendingFocus: number | null = null
function cancelPendingFocus(): void {
  if (pendingFocus === null) return
  cancelAnimationFrame(pendingFocus)
  pendingFocus = null
}
onBeforeUnmount(() => {cancelPendingFocus();stopPickerFocusGuard()})
onDeactivated(() => {cancelPendingFocus();stopPickerFocusGuard()})
watch(() => props.swatches.map(swatch => swatch.value), cancelPendingFocus)
watch(() => props.modelValue, (value) => {
  colorDraft.value = value
  invalidColor.value = false
})
const isCustom = computed(() => Boolean(props.modelValue) && !props.swatches.some((swatch) => swatch.value === props.modelValue))
// 漫游焦点落在当前选中的色块；自定义颜色由取色器表示，此时焦点回到“默认”。
const focusIndex = computed(() => Math.max(0, props.swatches.findIndex((swatch) => swatch.value === props.modelValue) + 1))

function select(value: string | null | undefined): void {
  cancelPendingFocus()
  applyColorSelection(value)
}

function applyColorSelection(value: string | null | undefined): void {
  const normalized = normalizeTranslationColor(value ?? '')
  colorDraft.value = normalized
  invalidColor.value = false
  emit('update:modelValue', normalized)
}

function commitColorDraft(): void {
  const input = colorDraft.value.trim()
  const normalized = normalizeTranslationColor(input)
  if (input && !normalized) {
    invalidColor.value = true
    return
  }
  select(normalized)
}

function handleKeydown(event: KeyboardEvent, currentIndex: number): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  cancelPendingFocus()
  event.preventDefault()
  const count = props.swatches.length + 1
  const nextIndex = event.key === 'Home' ? 0
    : event.key === 'End' ? count - 1
      : (currentIndex + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + count) % count
  const value = nextIndex === 0 ? '' : props.swatches[nextIndex - 1].value
  const group = groupElement.value!
  const focusRoot = group.getRootNode() as Document | ShadowRoot
  const origin = event.currentTarget
  pendingFocus = requestAnimationFrame(() => {
    pendingFocus = null
    // 用户离开色板或父级替换颜色后，旧按键不能把焦点带回原控件。
    if (!group.isConnected || focusRoot.activeElement !== origin || props.modelValue !== value) return
    group.querySelector<HTMLButtonElement>(`button[data-choice-index="${nextIndex}"]`)?.focus()
  })
  // 先登记待清理帧，再发出选择，使同步父级卸载也能取消它。
  applyColorSelection(value)
}
</script>

<style scoped>
.translation-color-field {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.translation-color-copy {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
}

.translation-color-copy strong {
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1.45;
}

.translation-color-copy small {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
}

/* 色块在空间不足时于组内换行，自定义取色器固定跟在第一行末尾。 */
.translation-color-options {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 6px;
}

.translation-color-choices {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.translation-color-default {
  height: 26px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
  font-weight: 700;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}

.translation-color-default:hover { color: var(--ink); border-color: color-mix(in srgb, var(--brand) 40%, var(--line)); }
.translation-color-default.selected { border-color: var(--brand); color: var(--brand-strong); background: var(--brand-soft); }

.translation-color-swatch {
  position: relative;
  width: 26px;
  height: 26px;
  flex: none;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  background: var(--translation-swatch);
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 140ms ease;
}

.translation-color-swatch:hover { transform: scale(1.1); }
.translation-color-swatch.selected { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--brand); }

.translation-color-swatch > i {
  position: absolute;
  inset: 8px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, .28);
  opacity: 0;
  transition: opacity 140ms ease;
}

.translation-color-swatch.selected > i { opacity: 1; }

.translation-color-default:focus-visible,
.translation-color-swatch:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 55%, transparent);
  outline-offset: 2px;
}

.translation-color-custom {
  display: inline-flex;
  flex: none;
  margin-left: 2px;
  padding-left: 8px;
  border-left: 1px solid var(--line);
}

.translation-color-custom :deep(.el-color-picker__trigger) {
  width: 26px;
  height: 26px;
  padding: 2px;
  border-radius: 999px;
}

.translation-color-custom :deep(.el-color-picker__color),
.translation-color-custom :deep(.el-color-picker__color-inner) {
  border-radius: 999px;
}

/* 未使用自定义色时显示彩虹色环，表示可以选择任意颜色。 */
.translation-color-custom:not(.selected) :deep(.el-color-picker__color) {
  border: 0;
  background: conic-gradient(#ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444);
}

.translation-color-custom:not(.selected) :deep(.el-color-picker__empty),
.translation-color-custom :deep(.el-color-picker__icon) {
  display: none;
}

.translation-color-custom.selected :deep(.el-color-picker__trigger) {
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--brand);
}

.translation-color-value {
  box-sizing: border-box;
  width: min(100%, 250px);
  min-height: 28px;
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  font-size: 10.5px;
}

.translation-color-value:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.translation-color-value[aria-invalid="true"] { border-color: #dc2626; }
.translation-color-error { color: #b91c1c; font-size: 10.5px; }
</style>
