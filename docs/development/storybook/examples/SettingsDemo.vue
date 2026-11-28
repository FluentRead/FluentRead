<script setup lang="ts">
import { ref } from 'vue'
import {ElButton, ElInput, ElOption, ElSwitch} from 'element-plus'
import SettingsGroup from '@/src/features/settings/ui/components/SettingsGroup.vue'
import SettingsItem from '@/src/features/settings/ui/components/SettingsItem.vue'
import SettingsDisclosure from '@/src/features/settings/ui/components/SettingsDisclosure.vue'
import SettingsNumberInput from '@/src/features/settings/ui/components/SettingsNumberInput.vue'
import '@/src/features/settings/ui/components/settings-controls.css'
import UiSelect from '@/src/ui/components/UiSelect.vue'
withDefaults(defineProps<{longLabels?: boolean; needsSetup?: boolean}>(), {longLabels: false, needsSetup: false})
const enabled = ref(true)
const language = ref('zh-CN')
const terminology = ref('FluentRead → 流畅阅读')
const previewVisible = ref(false)
const delay = ref(300)
</script>
<template>
  <div class="fr-story-stack fr-story-settings settings-card fr-settings-controls">
    <div><h1>阅读与翻译</h1><p class="fr-story-note">主操作、常用设置和按需配置分层展示。修改只保留在此预览中。</p></div>
    <SettingsGroup title="网页翻译" description="选择日常使用的语言和阅读方式。">
      <template #heading-extra><ElButton text @click="previewVisible = !previewVisible">{{ previewVisible ? '收起预览' : '查看预览' }}</ElButton></template>
      <SettingsItem :label="longLabels ? '翻译后默认显示的目标语言' : '目标语言'" :description="longLabels ? '自动识别网页原文，使用所选语言显示译文；选项较长时也应完整显示。' : undefined">
        <UiSelect v-model="language" aria-label="目标语言">
          <ElOption label="简体中文" value="zh-CN" />
          <ElOption label="English · 英语" value="en-US" />
          <ElOption label="繁體中文（台灣）" value="zh-TW" />
        </UiSelect>
      </SettingsItem>
      <SettingsItem :label="longLabels ? '保留网页原文并在相邻位置显示译文' : '双语对照'" description="阅读时可以随时对照原文。">
        <ElSwitch v-model="enabled" aria-label="双语对照" />
      </SettingsItem>
      <SettingsItem label="悬浮翻译延迟" help="增加延迟可以减少短暂划过段落时的误触。">
        <SettingsNumberInput v-model="delay" unit="ms" :min="0" :max="3000" :step="100" aria-label="悬浮翻译延迟" />
      </SettingsItem>
      <SettingsItem v-if="previewVisible" label="阅读预览" stacked>
        <div class="fr-story-reading-preview"><p>Read at your own pace.</p><p v-if="enabled">按自己的节奏阅读。</p></div>
      </SettingsItem>
    </SettingsGroup>
    <SettingsDisclosure
      id="demo-translation-preferences"
      title="更多翻译偏好"
      description="仅在需要时调整术语与特殊规则。"
      :status="needsSetup ? '待配置' : '已设置术语'"
      :status-tone="needsSetup ? 'warning' : 'neutral'"
    >
      <SettingsItem label="自定义术语" description="收起后再次展开，输入内容仍会保留。" stacked>
        <ElInput v-model="terminology" aria-label="自定义术语" />
      </SettingsItem>
    </SettingsDisclosure>
    <div class="fr-story-row fr-story-actions">
      <ElButton type="primary" @click="previewVisible = true">预览翻译</ElButton>
      <ElButton @click="enabled = true; language = 'zh-CN'; terminology = 'FluentRead → 流畅阅读'; delay = 300; previewVisible = false">恢复示例</ElButton>
    </div>
  </div>
</template>
<style scoped>
.fr-story-settings { gap: var(--fr-card-gap); }
.fr-story-settings > :deep(.settings-group), .fr-story-settings > :deep(.settings-disclosure) { margin-bottom: 0; }
.fr-story-actions { gap: var(--fr-action-gap); }
.fr-story-reading-preview { width: 100%; padding: 16px; border-radius: var(--fr-control-radius); background: var(--surface-soft); }
.fr-story-reading-preview p { margin: 0; }
.fr-story-reading-preview p + p { margin-top: 8px; color: var(--muted); }
</style>
