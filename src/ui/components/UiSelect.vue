<!--
 * @file src/ui/components/UiSelect.vue
 * 文件职责：提供扩展界面统一的下拉选择外观，避免浏览器原生菜单破坏品牌风格。
 * 主要内容：复用 Element Plus 的选择、筛选、多选、键盘与弹层定位，支持按调用方需要独立关闭搜索装饰，单选长标签在关闭时自然换行，透传属性、事件和插槽；仅为 Shadow Root 菜单监听窄屏变化，以实例局部指令保留鼠标目标与外部传播，缓存停用时关闭菜单并清理监听。
 * 模块边界：不解释选项、不读写配置；选项内容和挂载容器由调用方提供，不用于宿主网页原生控件。
 -->
<template>
  <ElSelect
    ref="select"
    class="fluentread-select"
    :class="{'fluentread-select--wrap-label': wrapLabel && !multiple && !menuOpen}"
    :show-arrow="false"
    :offset="6"
    :fit-input-width="true"
    :filterable="filterable"
    :multiple="multiple"
    :teleported="teleported"
    :placement="placement"
    :fallback-placements="insideShadowRoot ? ['bottom-start', 'top-start', 'right', 'left'] : undefined"
    :no-match-text="t('select.noMatch')"
    :no-data-text="t('select.noData')"
    v-bind="$attrs"
    :popper-class="['fluentread-select-popper', filterable && 'fluentread-select-popper--searchable', popperClass].filter(Boolean).join(' ')"
    @visible-change="menuOpen = $event"
  >
    <template v-if="filterable && showSearchIcon !== false && (!slots.prefix || menuOpen)" #prefix>
      <svg class="fluentread-select-search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
    </template>
    <template v-if="filterable && !multiple && !slots.label" #label="{label}">
      <span>{{ menuOpen ? (searchPlaceholder || t('select.search')) : label }}</span>
    </template>
    <template v-for="name in Object.keys(slots).filter(name => name !== 'prefix' || !filterable || !menuOpen)" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps || {}" />
    </template>
  </ElSelect>
</template>
<script setup lang="ts">
import {computed, getCurrentInstance, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, useSlots, type Slots} from 'vue';
import {ClickOutside, ElSelect as ElementSelect} from 'element-plus';
import {createShadowSelectOutside} from '@/src/ui/shadowSelectOutside';
import {useUiI18n} from '@/src/ui/i18n';
import 'element-plus/es/components/select/style/css';
defineOptions({inheritAttrs: false});
withDefaults(defineProps<{
  wrapLabel?: boolean
  popperClass?: string
  filterable?: boolean
  showSearchIcon?: boolean
  multiple?: boolean
  searchPlaceholder?: string
}>(), {showSearchIcon: true, wrapLabel: true});
const {t} = useUiI18n();
const menuOpen = ref(false);
const slots: Slots = useSlots();
const select = ref<InstanceType<typeof ElementSelect>>();
const shadowOutside = createShadowSelectOutside(ClickOutside);
// 仅替换本实例的指令定义，保留原选择器与全局 ClickOutside。
const ElSelect = {...ElementSelect, directives: {...ElementSelect.directives, ClickOutside: shadowOutside.directive}};
const teleported = ref(true);
const componentInstance = getCurrentInstance();
const narrowViewport = ref(false);
const insideShadowRoot = ref(false);
const placement = computed(() => insideShadowRoot.value && narrowViewport.value ? 'top-start' : 'bottom-start');
const updateViewportPlacement = () => {
  narrowViewport.value = typeof window !== 'undefined' && window.innerWidth <= 700;
};
let listeningToViewport = false;
function startViewportListener() {
  // 只有 Shadow Root 内的小屏菜单需要随窗口变化调整方向。
  if (!insideShadowRoot.value || listeningToViewport) return;
  updateViewportPlacement();
  window.addEventListener('resize', updateViewportPlacement);
  listeningToViewport = true;
}
function stopViewportListener() {
  if (!listeningToViewport) return;
  window.removeEventListener('resize', updateViewportPlacement);
  listeningToViewport = false;
}
onMounted(() => {
  const element = componentInstance?.vnode.el;
  if (element instanceof HTMLElement && element.getRootNode() instanceof ShadowRoot) {
    insideShadowRoot.value = true;
    teleported.value = false;
  }
  startViewportListener();
  shadowOutside.start();
});
onActivated(() => {startViewportListener();shadowOutside.start();});
onDeactivated(() => {
  select.value?.blur();
  menuOpen.value = false;
  stopViewportListener();
  shadowOutside.stop();
});
onBeforeUnmount(() => {stopViewportListener();shadowOutside.stop();});
defineExpose({
  focus: () => select.value?.focus(),
  blur: () => select.value?.blur(),
});
</script>
<style>
.fluentread-select {
  min-width: 0;
  width: 100%;
  --el-color-primary: var(--brand, #ef4776);
  --el-text-color-regular: var(--ink, #172033);
  --el-text-color-placeholder: var(--muted, #737c8f);
  --el-fill-color-blank: var(--surface, #fff);
}
.fluentread-select .el-select__wrapper {
  min-height: var(--fr-control-min-height, 38px);
  padding: 6px 12px;
  border: 1px solid var(--line, #e3e6ed);
  border-radius: var(--fr-control-radius, 8px);
  background: var(--surface-soft, #f6f7f9);
  box-shadow: none;
  transition: border-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), box-shadow var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}
.fluentread-select .el-select__wrapper:not(.is-disabled):hover {
  border-color: var(--fr-color-line-strong, var(--line));
  background: var(--surface, #fff);
}
.fluentread-select .el-select__wrapper.is-focused:not(.is-disabled) {
  border-color: var(--brand-strong, #d4235a);
  background: var(--surface, #fff);
  box-shadow: var(--fr-focus-ring);
}
.fluentread-select .el-select__wrapper.is-disabled { opacity: .6; cursor: not-allowed; }
.fluentread-select .el-select__selected-item,
.fluentread-select .el-select__input { color: var(--ink, #172033); font-size: 13px; }
/* 焦点由外层完整控件显示；皮肤的全局输入焦点规则也不能在内部重复绘制矩形。 */
.fluentread-select .el-select__input:focus-visible { outline: none !important; }
.fluentread-select .el-select__placeholder.is-transparent { color: var(--muted, #737c8f); }
.fluentread-select .el-select__caret { color: var(--muted, #737c8f); font-size: 14px; }
.fluentread-select--wrap-label .el-select__selection { align-items: center; }
/* 关闭时用标签撑开高度，筛选输入保留焦点入口但不额外占一行。 */
.fluentread-select--wrap-label .el-select__input-wrapper { position: absolute; inset: 0; opacity: 0; }
.fluentread-select--wrap-label .el-select__placeholder {
  position: static;
  transform: none;
  overflow: visible;
  white-space: normal;
  text-overflow: clip;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.fluentread-select--wrap-label .el-select__placeholder > span { white-space: normal; }
.fluentread-select-search-icon { width: 15px; height: 15px; flex: none; fill: none; stroke: var(--muted, #737c8f); stroke-width: 1.5; stroke-linecap: round; }
.fluentread-select .el-tag { --el-tag-text-color: var(--ink, #172033); --el-tag-bg-color: var(--surface, #fff); --el-tag-border-color: var(--line, #e5e8ef); border-radius: 6px; }

.fluentread-select-popper.el-popper {
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  border: 1px solid var(--line, #e5e8ef);
  border-radius: var(--fr-menu-radius, 14px);
  background: var(--surface, #fff);
  box-shadow: var(--fr-menu-shadow, 0 8px 28px rgba(27, 36, 57, .12));
  --el-bg-color-overlay: var(--surface, #fff);
  --el-color-primary: var(--brand, #ef4776);
  --el-border-color-light: var(--line, #e5e8ef);
  --el-text-color-regular: var(--ink, #172033);
  --el-text-color-placeholder: var(--muted, #737c8f);
  --el-fill-color-light: var(--surface-soft, #f7f8fb);
}
/* 退场菜单及时让出鼠标命中，避免切换选择器时截走松开事件。 */
.fluentread-select-popper.el-zoom-in-top-leave-active { pointer-events: none; }
.fluentread-select-popper .el-select-dropdown { max-width: calc(100vw - 26px); border-radius: inherit; }
.fluentread-select-popper--searchable .el-select-dropdown { min-width: min(220px, calc(100vw - 26px)); }
.fluentread-select-popper .el-select-dropdown__wrap { max-height: min(320px, 50vh); overscroll-behavior: contain; }
.fluentread-select-popper .el-select-dropdown__list { padding: 6px; }
.fluentread-select-popper .el-select-dropdown__item {
  display: flex;
  align-items: center;
  position: relative;
  height: auto;
  min-height: 38px;
  margin: 2px 0;
  padding: 8px 34px 8px 12px;
  border-radius: 9px;
  color: var(--ink, #172033);
  font-size: 13px;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
}
.fluentread-select-popper .el-select-dropdown__item.is-hovering:not(.is-disabled) { background: var(--surface-soft, #f7f8fb); }
.fluentread-select-popper .el-select-dropdown__item.is-selected {
  color: var(--brand-strong, #dc315f);
  background: var(--brand-soft, #fff0f4);
  font-weight: 650;
}
.fluentread-select-popper .el-select-dropdown__item.is-selected.is-hovering { background: var(--brand-soft, #fff0f4); }
/* 单选和多选共用无文字的勾选标记；多选标签仍由 Element Plus 管理。 */
.fluentread-select-popper.el-popper .el-select-dropdown .el-select-dropdown__item.is-selected::after {
  content: '';
  position: absolute;
  right: 14px;
  top: 50%;
  width: 5px;
  height: 9px;
  border: solid currentColor;
  border-width: 0 1.7px 1.7px 0;
  background: none;
  mask: none;
  transform: translateY(-65%) rotate(45deg);
}
.fluentread-select-popper .el-select-dropdown__item.is-disabled { color: var(--muted, #737c8f); cursor: not-allowed; }
.fluentread-select-popper .el-select-group__title { height: auto; padding: 10px 12px 5px; color: var(--muted, #737c8f); font-size: 11px; font-weight: 600; line-height: 1.5; }
.fluentread-select-popper .el-select-group__wrap:not(:last-of-type) { padding-bottom: 9px; }
.fluentread-select-popper .el-select-group__wrap:not(:last-of-type)::after { right: 12px; bottom: 2px; left: 12px; background: var(--line, #e5e8ef); }
.fluentread-select-popper .el-select-dropdown__empty { margin: 0; padding: 24px 16px; color: var(--muted, #737c8f); font-size: 13px; }
.fluentread-select-popper .el-popper__arrow::before { border-color: var(--line, #e5e8ef); background: var(--surface, #fff); }
@media (prefers-reduced-motion: reduce) {
  .fluentread-select .el-select__wrapper { transition: none; }
}
</style>
