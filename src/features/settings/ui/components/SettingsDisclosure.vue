<!--
@file src/features/settings/ui/components/SettingsDisclosure.vue
文件职责：提供与设置卡片一致的原生折叠容器，让次要配置按需展开且摘要保留状态。
主要内容：标题、可选说明和状态组成可点击摘要，状态支持中性、警告和错误语义及自定义插槽；默认插槽始终挂载，收起不销毁表单或中断保存；单一 details 根透传 id、锚点标记和原生 toggle 事件，默认展开仅决定初始状态。
模块边界：只负责展示，不读取配置、不持久化、不接管原生键盘展开或焦点；调用方决定状态含义、内容控件所属及是否需要阻止隐藏期间的业务操作。
-->
<template>
  <details class="settings-disclosure" :open="initiallyOpen">
    <summary class="settings-disclosure-summary">
      <span class="settings-disclosure-copy">
        <strong>{{ title }}</strong>
        <small v-if="description">{{ description }}</small>
      </span>
      <span v-if="status || $slots.status" class="settings-disclosure-status" :class="`is-${statusTone}`">
        <slot name="status">{{ status }}</slot>
      </span>
      <svg class="settings-disclosure-chevron details-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
    </summary>
    <div class="settings-disclosure-body"><slot /></div>
  </details>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  title: string
  description?: string
  status?: string
  statusTone?: 'neutral' | 'warning' | 'danger'
  defaultOpen?: boolean
}>(), {description: '', status: '', statusTone: 'neutral', defaultOpen: false})
const initiallyOpen = props.defaultOpen
</script>

<style scoped>
.settings-disclosure {
  box-sizing: border-box;
  width: min(100%, 1080px);
  min-width: 0;
  margin: 0 auto var(--fr-card-gap, 20px);
  border: var(--fr-card-outline, 1px solid var(--line));
  border-radius: var(--fr-card-radius, 14px);
  background: var(--fr-card-background, var(--surface));
  box-shadow: var(--fr-card-shadow, none);
}
.settings-disclosure-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: var(--fr-card-heading-padding-block, 16px) var(--fr-card-padding-inline, 20px);
  border-radius: var(--fr-card-radius, 14px);
  color: var(--ink);
  background: transparent;
  list-style: none;
  cursor: pointer;
}
.settings-disclosure-summary::-webkit-details-marker { display: none; }
.settings-disclosure-summary::marker { content: ''; }
.settings-disclosure-summary:hover { background: var(--surface-soft); }
.settings-disclosure-summary:focus-visible { outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong)); outline-offset: 2px; }
.settings-disclosure-copy { display: grid; flex: 1; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.settings-disclosure-copy strong { color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.45; }
.settings-disclosure-copy small { color: var(--muted); font-size: var(--fr-card-description-size, 12px); font-weight: 400; line-height: 1.55; }
.settings-disclosure-status { max-width: 40%; margin-inline-start: auto; color: var(--muted); font-size: 12px; font-weight: 500; line-height: 1.5; text-align: end; overflow-wrap: anywhere; }
.settings-disclosure-status.is-warning { color: var(--fr-warning, #94651c); }
.settings-disclosure-status.is-danger { color: var(--fr-danger, #b1435e); }
.settings-disclosure-chevron { flex: none; width: 18px; height: 18px; color: var(--muted); transition: transform var(--fr-duration-fast, 160ms) var(--fr-ease-out, ease); }
.settings-disclosure[open] > .settings-disclosure-summary { border-bottom: 1px solid var(--fr-card-border, var(--line)); border-end-start-radius: 0; border-end-end-radius: 0; }
.settings-disclosure[open] > .settings-disclosure-summary .settings-disclosure-chevron { transform: rotate(90deg); }
.settings-disclosure-body { min-width: 0; border-radius: 0 0 var(--fr-card-radius, 14px) var(--fr-card-radius, 14px); }
.settings-disclosure-body > :deep(.settings-group) { width: 100%; margin: 0; border: 0; border-start-start-radius: 0; border-start-end-radius: 0; box-shadow: none; }
.settings-disclosure-body > :deep(.settings-item + .settings-item) { border-top: 1px solid var(--fr-card-border, var(--line)); }
@media (max-width: 700px) {
  .settings-disclosure-summary { gap: 10px; }
}
</style>
