<script setup lang="ts">
import { ref } from 'vue'
import { ElButton, ElDialog, ElInput, ElSwitch, ElTooltip } from 'element-plus'
import '@/src/features/settings/ui/components/settings-controls.css'
const prompt = ref('把选中的文字翻译成简体中文。')
const enabled = ref(true)
const open = ref(false)
</script>
<template>
  <div class="fr-story-stack settings-card fr-settings-controls">
    <div>
      <p class="fr-story-note">同一区域只保留一个主操作。次要操作使用中性按钮，辅助入口使用文字按钮。</p>
      <div class="fr-story-row"><ElButton type="primary" @click="open = true">打开预览弹窗</ElButton><ElButton @click="prompt = '把选中的文字翻译成简体中文。'">恢复示例</ElButton><ElButton text @click="open = true">查看说明</ElButton><ElButton disabled>不可用</ElButton></div>
    </div>
    <label class="fr-story-field"><span>提示词示例</span><ElInput v-model="prompt" aria-label="提示词示例" /></label>
    <div class="fr-story-row"><ElSwitch v-model="enabled" aria-label="双语显示" /><span>双语显示</span><ElTooltip content="保留原文，并在相邻位置展示译文。"><ElButton>查看说明</ElButton></ElTooltip></div>
    <ElDialog v-model="open" title="组件预览" width="min(440px, calc(100vw - 32px))">
      <p>这是设置页使用的 Element Plus 弹窗。可以通过关闭按钮或 Escape 返回。</p>
      <template #footer><ElButton @click="open = false">取消</ElButton><ElButton type="primary" @click="open = false">完成</ElButton></template>
    </ElDialog>
  </div>
</template>
