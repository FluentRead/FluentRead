<!--
 @file .agents/skills/fluentread-ui/examples/settings-section-example.vue
 文件职责：展示符合 FluentRead 设计体系的标准设置分区写法，供新增或重构 Options 页面时直接参照。
 主要内容：复用 SettingsGroup、SettingsItem、SettingsDisclosure、SegmentedControl 与 UiSelect，完全消费 tokens.css 语义变量，支持浅色、深色、全部皮肤与多语言换行。
 模块边界：本文件为设计技能参考示例，不参与运行时打包。
-->
<template>
  <section class="settings-section fr-settings-controls">
    <SettingsGroup
      title="阅读与译文展示"
      description="统一配置日常网页阅读时的显示方式与响应节奏。"
    >
      <SettingsItem
        label="默认翻译模式"
        description="双语对照保留原文便于核对，仅译文模式适合快速扫读。"
      >
        <SegmentedControl
          v-model="displayMode"
          label="默认翻译模式"
          :options="displayModeOptions"
        />
      </SettingsItem>

      <SettingsItem
        label="悬浮触发延迟"
        help="适度提高延迟可减少指针划过正文时的误触发。"
      >
        <SettingsNumberInput
          v-model="hoverDelayMs"
          unit="ms"
          :min="0"
          :max="2000"
          :step="50"
          aria-label="悬浮触发延迟"
        />
      </SettingsItem>
    </SettingsGroup>

    <SettingsDisclosure
      id="example-advanced-reading"
      title="高级阅读偏好"
      description="仅在有特定阅读习惯时按需调整，收起后保留输入草稿。"
      :status="customRuleCount ? `已配置 ${customRuleCount} 条` : '默认'"
      status-tone="neutral"
    >
      <SettingsItem label="自动跟随站点主题" description="在深色网页中自动柔化译文对比度。">
        <ElSwitch v-model="followSiteTheme" aria-label="自动跟随站点主题" />
      </SettingsItem>
    </SettingsDisclosure>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElSwitch } from 'element-plus'
import SettingsGroup from '@/src/features/settings/ui/components/SettingsGroup.vue'
import SettingsItem from '@/src/features/settings/ui/components/SettingsItem.vue'
import SettingsDisclosure from '@/src/features/settings/ui/components/SettingsDisclosure.vue'
import SettingsNumberInput from '@/src/features/settings/ui/components/SettingsNumberInput.vue'
import SegmentedControl, { type SegmentedOption } from '@/src/features/settings/ui/components/SegmentedControl.vue'

const displayMode = ref<number>(1)
const hoverDelayMs = ref<number>(250)
const followSiteTheme = ref<boolean>(true)
const customRuleCount = ref<number>(0)

const displayModeOptions: SegmentedOption[] = [
  { label: '仅译文模式', value: 0 },
  { label: '双语对照模式', value: 1 },
]
</script>
