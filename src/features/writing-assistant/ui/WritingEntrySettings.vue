<!--
 * @file src/features/writing-assistant/ui/WritingEntrySettings.vue
 * 文件职责：提供写作入口的三种关闭范围、当前呼出快捷键提示和完整设置入口。
 * 主要内容：在隔离浮层中选择本次访问、当前网站或永久关闭，展示通用网页呼出快捷键说明；支持取消、键盘焦点循环、保存中状态和失败反馈。
 * 模块边界：只呈现选项并发送用户操作，不持久化配置、不读取草稿也不执行模型请求。
 -->
<template>
  <WritingPopover :active="active" :anchor="anchor" :width="350">
    <section v-show="active" ref="dialog" class="writing-entry-settings" :class="{'is-dark': dark}" role="dialog" :aria-label="t('writing.entry.closeTitle')" tabindex="-1" @keydown.stop="handleKeydown">
      <header><h2>{{ t('writing.entry.closeTitle') }}</h2><button type="button" class="icon" :disabled="saving" :aria-label="t('writing.entry.cancel')" @click="emit('close')">×</button></header>
      <p v-if="hotkey" class="writing-entry-hotkey" data-writing-entry-hotkey>{{ t('writing.hotkey.entryHint', {shortcut: hotkey}) }}</p>
      <fieldset :disabled="saving">
        <legend class="sr-only">{{ t('writing.entry.scope') }}</legend>
        <label v-for="item in choices" :key="item.value"><input v-model="scope" type="radio" name="fluentread-writing-close-scope" :value="item.value" /><span>{{ t(item.label) }}<small v-if="item.value !== 'visit'">{{ t('writing.entry.restoreHint') }}</small></span></label>
      </fieldset>
      <p v-if="error" role="alert">{{ error }}</p>
      <footer><button type="button" class="settings-link" :disabled="saving" @click="emit('settings')">{{ t('writing.entry.settings') }}</button><button type="button" :disabled="saving" @click="emit('close')">{{ t('writing.entry.cancel') }}</button><button type="button" class="primary" :disabled="saving" @click="emit('save', scope)">{{ t(saving ? 'writing.entry.saving' : 'writing.entry.save') }}</button></footer>
    </section>
  </WritingPopover>
</template>
<script setup lang="ts">
import {nextTick, ref, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import WritingPopover from './WritingPopover.vue';
const props = defineProps<{active: boolean; anchor?: HTMLElement; dark: boolean; saving: boolean; error: string; hotkey?: string}>();
const emit = defineEmits<{close: []; save: [scope: 'visit' | 'site' | 'forever']; settings: []}>();
const {t} = useUiI18n();
const dialog = ref<HTMLElement>(); const scope = ref<'visit' | 'site' | 'forever'>('visit');
const choices = [{value: 'visit', label: 'writing.entry.visit'}, {value: 'site', label: 'writing.entry.site'}, {value: 'forever', label: 'writing.entry.forever'}] as const;
watch(() => props.active, async active => { if (!active) return; scope.value = 'visit'; await nextTick(); if (props.active) dialog.value?.querySelector<HTMLInputElement>('input:checked')?.focus({preventScroll: true}); });
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); if (!props.saving) emit('close'); }
  if (event.key !== 'Tab') return;
  const controls = [...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled), input:checked:not(:disabled)')];
  const current = dialog.value!.getRootNode() as ShadowRoot;
  if (!controls.length) { event.preventDefault(); return; }
  if (event.shiftKey && (current.activeElement === controls[0] || current.activeElement === dialog.value)) { event.preventDefault(); controls.at(-1)!.focus(); }
  else if (!event.shiftKey && current.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
}
</script>
<style scoped>
.writing-entry-settings{--bg:#fff;--ink:#28323f;--soft:#f7f8fb;--line:#e3e7ee;--muted:#7c8799;box-sizing:border-box;padding:16px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 48px #152c4122;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-height:calc(100dvh - 24px);overflow:auto;text-align:left;color-scheme:light}
.is-dark{--bg:#252830;--ink:#e5e7ec;--soft:#1f2229;--line:#454951;--muted:#acb4c2;color-scheme:dark}
header,footer{display:flex;align-items:center;gap:8px}h2{font-size:15px;margin:0;flex:1}button{cursor:pointer;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 12px}button:disabled{opacity:.5;cursor:default}.icon{border:0;font-size:22px;padding:0 5px;color:var(--muted)}.writing-entry-hotkey{margin:10px 0 0;padding:8px 10px;border-radius:8px;background:var(--soft);color:var(--muted);font-size:12px}fieldset{border:0;padding:8px 10px;margin:14px 0;background:var(--soft);border-radius:10px}label{display:flex;align-items:flex-start;gap:9px;padding:8px 0;cursor:pointer}input{accent-color:#ef4776;margin:4px 0 0}small{display:block;color:var(--muted);font-size:11px}footer{flex-wrap:wrap;justify-content:flex-end}.settings-link{margin-right:auto;border:0;background:transparent;padding-inline:0;color:#ef4776;font-size:12px}.primary{background:#ef4776;border-color:#ef4776;color:#fff}p[role=alert]{font-size:12px;color:#c55b4e}button:focus-visible,input:focus-visible{outline:2px solid #ef4776;outline-offset:2px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
</style>
