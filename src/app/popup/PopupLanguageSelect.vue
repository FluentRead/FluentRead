<!--
 @file src/app/popup/PopupLanguageSelect.vue
 文件职责：隔离 Popup 语言选择器的渲染，使关闭的菜单不创建完整语言选项 DOM。
 主要内容：关闭时显示已保存语言在当前界面语言中的主名称，菜单和提示保留完整多语名称；触屏列表按实际可见视口限制内部滚动并保留独立关闭入口，只在所属菜单打开时订阅视口；配对往返缓存恢复后开启新的选择上下文，普通退出和卸载保持终止；保留 UiSelect 的搜索、键盘与定位及语言文案缓存，拒绝已关闭、禁用、失活或旧选择上下文的事件。
 模块边界：不读写配置或浏览器状态，选择结果通过 v-model 交给 PopupApp 持久化。
-->
<template>
  <UiSelect
    ref="select"
    :key="controlRevision"
    class="popup-language-select"
    popper-class="fluentread-popup-language-popper"
    :popper-options="touchPopperOptions"
    :model-value="modelValue"
    :disabled="!context.active.value"
    :title="selectedLabel"
    filterable
    :wrap-label="!props.singleLine"
    :show-search-icon="false"
    :persistent="false"
    :onUpdate:modelValue="selectActions.choose"
    :onVisibleChange="selectActions.visible"
  >
    <template #label><span data-i18n-ignore>{{ menuOpen ? t('select.search') : selectedLabel.split(' / ')[0] }}</span></template>
    <ElOption v-for="item in languageOptions" :key="item.value" :value="item.value" :label="item.label" data-i18n-ignore />
    <template v-if="touchViewport" #footer>
      <button type="button" class="popup-language-close" :onClick="selectActions.close">{{ t('common.close') }}</button>
    </template>
  </UiSelect>
</template>
<script setup lang="ts">
import {computed, onBeforeUnmount, ref, shallowRef, watch} from 'vue';
import {ElOption} from 'element-plus';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {getMultilingualTargetLanguageLabel, options} from '@/src/core/config/catalog';
import {useUiI18n} from '@/src/ui/i18n';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {getVisualViewportRect, observeVisualViewport, type VisualViewportRect} from '@/src/platform/dom/visualViewport';

const props = defineProps<{modelValue: string; source?: boolean; disabled?: boolean; singleLine?: boolean}>();
const emit = defineEmits<{(event: 'update:modelValue', value: string): void}>();
const {language, t, translateLegacy} = useUiI18n();
const menuOpen = ref(false);
const select = shallowRef<InstanceType<typeof UiSelect> | null>(null);
const touchViewport = shallowRef<VisualViewportRect>();
const pageExited = ref(false);
let persistedHidden = false;
let terminal = false;
const controlRevision = ref(0);
const choices = computed(() => props.source ? options.from : options.to);
const context = useSettingsActionContext(() => !props.disabled && !pageExited.value,
  () => [Boolean(props.source), props.modelValue, menuOpen.value]);
let releaseViewport: (() => void) | undefined;
watch(context.revision, () => {
  releaseViewport?.();releaseViewport = undefined;touchViewport.value = undefined;
  if (!menuOpen.value || !context.active.value) return;
  let touch = document.documentElement.hasAttribute('data-fluentread-android-popup');
  try {touch ||= window.matchMedia('(any-pointer: coarse)').matches;} catch { /* 平台能力不可用时仍保留已确认的 Android 标记。 */ }
  if (!touch) return;
  const current = context.capture();
  const update = () => {if (current() && menuOpen.value) touchViewport.value = getVisualViewportRect();};
  update();releaseViewport = observeVisualViewport(update);
}, {flush: 'sync'});
const touchPopperOptions = computed(() => {
  const viewport = touchViewport.value;
  if (!viewport) return undefined;
  const current = context.capture();
  return {strategy: 'fixed' as const, modifiers: [
    // Popper 的 effect 先于几何测量；仅给该实例的 portal 写变量，视口变化会让原实例重新定位。
    {name: 'fluentreadPopupLanguageViewport', enabled: true, phase: 'beforeRead' as const, fn: () => undefined,
      effect: ({state}: {state: {elements: {popper: HTMLElement}}}) => {
        const popper = state.elements.popper, height = `${viewport.height}px`;
        if (!current() || !menuOpen.value || !popper.classList.contains('fluentread-popup-language-popper')) return;
        popper.style.setProperty('--fluentread-popup-language-height', height);
        return () => {if (popper.style.getPropertyValue('--fluentread-popup-language-height') === height) popper.style.removeProperty('--fluentread-popup-language-height');};
      }},
    {name: 'preventOverflow', options: {padding: 4, altAxis: true, tether: false, rootBoundary: 'viewport'}},
    {name: 'flip', options: {padding: 4, fallbackPlacements: ['bottom-start', 'top-start'], rootBoundary: 'viewport'}},
  ]};
});
// 只在控件所属范围变化时重建，正常选择或外部值同步保留输入焦点和语言列表缓存。
watch(() => [context.active.value, Boolean(props.source)], () => {
  controlRevision.value += 1;
  menuOpen.value = false;
}, {flush: 'sync'});
const selectActions = computed(() => {
  const current = context.capture();
  return {
    choose: (value: string) => {
      if (current() && menuOpen.value && value !== props.modelValue && choices.value.some(item => item.value === value)) {
        emit('update:modelValue', value);
      }
    },
    visible: (value: boolean) => {if (current()) menuOpen.value = value;},
    close: () => {if (current() && menuOpen.value) {select.value?.blur();menuOpen.value = false;}},
  };
});
function handlePageHide(event: PageTransitionEvent): void {
  if (terminal) return;
  persistedHidden = event.persisted;
  if (!event.persisted) terminal = true;
  pageExited.value = true;
}
function handlePageShow(event: PageTransitionEvent): void {
  if (!event.persisted || !persistedHidden || terminal) return;
  persistedHidden = false;
  pageExited.value = false;
}
window.addEventListener('pagehide', handlePageHide);
window.addEventListener('pageshow', handlePageShow);
onBeforeUnmount(() => {
  terminal = true;persistedHidden = false;
  releaseViewport?.();releaseViewport = undefined;
  window.removeEventListener('pagehide', handlePageHide);
  window.removeEventListener('pageshow', handlePageShow);
});
const label = (item: {value: string; label: string}) => item.value === 'auto'
  ? translateLegacy(item.label)
  : getMultilingualTargetLanguageLabel(item.value, item.label, language.value);
const selectedLabel = computed(() => label(choices.value.find(item => item.value === props.modelValue)
  || {value: props.modelValue, label: props.modelValue}));
const languageOptions = computed(() => choices.value.map(item => ({value: item.value, label: label(item)})));
</script>
