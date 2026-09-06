<!--
 * @file src/features/writing-assistant/ui/WritingMenu.vue
 * 文件职责：在回复入口旁提供写作助手设置与停用操作，让用户就地控制可见性。
 * 主要内容：区分当前访问、当前网站与所有网站的关闭范围，显示保存状态与失败反馈。
 * 模块边界：只发出明确的用户操作，由网页宿主管理临时状态和持久化；不直接修改页面或发送内容。
 -->
<template>
  <WritingPopover :active="active" :anchor="anchor" :width="300">
    <section ref="menu" class="writing-menu" :class="{'is-dark': dark}" role="dialog" aria-label="写作助手选项" tabindex="-1" @keydown.stop="keydown">
      <header><img :src="icon" alt="" /><strong>写作助手</strong><button type="button" class="close" aria-label="关闭选项" @click="emit('close')">×</button></header>
      <button type="button" :disabled="busy" @click="emit('settings')">写作助手设置 <span aria-hidden="true">↗</span></button>
      <hr />
      <button type="button" :disabled="busy" @click="emit('disable', 'visit')">本次关闭<small>下次访问时恢复</small></button>
      <button type="button" :disabled="busy" @click="emit('disable', 'site')">在当前网站停用<small>可在设置中重新开启</small></button>
      <button type="button" :disabled="busy" @click="emit('disable', 'all')">永久停用写作助手<small>可在设置中重新开启</small></button>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </WritingPopover>
</template>
<script setup lang="ts">
import {nextTick, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import WritingPopover from './WritingPopover.vue';
const props = defineProps<{active: boolean; anchor?: HTMLElement; dark: boolean; busy: boolean; error: string}>();
const emit = defineEmits<{close: []; settings: []; disable: [scope: 'visit' | 'site' | 'all']}>();
const icon = browser.runtime.getURL('/icon/128.png'); const menu = ref<HTMLElement>();
watch(() => props.active, async active => { if (active) { await nextTick(); menu.value?.focus({preventScroll: true}); } });
function keydown(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); emit('close'); } }
</script>
<style scoped>
.writing-menu{--m-bg:#fff;--m-ink:#28323f;--m-line:#edf0f3;--m-muted:#88929f;background:var(--m-bg);color:var(--m-ink);border:1px solid var(--m-line);border-radius:14px;padding:8px;box-shadow:0 12px 48px #152c4124;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left;max-height:calc(100dvh - 24px);overflow:auto;outline:none;color-scheme:light}.writing-menu.is-dark{--m-bg:#24262e;--m-ink:#edf0f5;--m-line:#393c48;--m-muted:#a1a8b5;color-scheme:dark}.writing-menu *{box-sizing:border-box}.writing-menu header{display:flex;align-items:center;gap:8px;padding:8px 9px 12px}.writing-menu img{width:24px;height:24px}.writing-menu strong{flex:1;font-size:14px}.writing-menu button{display:block;width:100%;padding:9px 12px;border:0;border-radius:8px;color:inherit;background:transparent;text-align:left;font:inherit;cursor:pointer}.writing-menu button:hover{background:color-mix(in srgb,#ef4776 8%,var(--m-bg))}.writing-menu button:focus-visible{outline:2px solid #ef4776;outline-offset:-2px}.writing-menu button:disabled{opacity:.5;cursor:default}.writing-menu button span{float:right;color:var(--m-muted)}.writing-menu .close{width:28px;padding:0;font-size:23px;text-align:center;color:var(--m-muted)}.writing-menu small{display:block;color:var(--m-muted);font-size:11px}.writing-menu hr{border:0;border-top:1px solid var(--m-line);margin:5px 8px}.writing-menu p{color:#c55b4e;font-size:12px;padding:0 12px}
</style>
