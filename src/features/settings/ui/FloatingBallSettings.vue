<!--
 * @file src/features/settings/ui/FloatingBallSettings.vue
 * 文件职责：提供悬浮球的进阶外观与交互设置，把按钮显示方式、展开延迟、点击行为、紧凑尺寸、设置入口、收起不透明度和禁用网站集中在一处编辑。
 * 主要内容：组件以分段控件和数字输入呈现各字段，写入前统一调用 core/config 的归一化函数，悬浮球关闭时禁用全部控件，并复用站点名单编辑器维护不显示悬浮球的域名。
 * 模块边界：它只修改传入的配置对象，不发送标签页消息、不挂载悬浮球也不实现站点匹配；持久化由设置页统一触发，页面侧生效由悬浮球 content runtime 订阅配置完成。
 -->
<template>
  <SettingsGroup
    title="悬浮球进阶设置"
    description="控制悬浮球的按钮显示方式、点击行为、尺寸与生效网站。关闭悬浮球后这些设置保留但不生效。"
  >
    <SettingsItem
      label="按钮显示方式"
      description="悬浮球上的翻译与设置按钮可以悬停时展开、始终显示，或完全隐藏只保留悬浮球本体。"
      :disabled="!enabled"
    >
      <SegmentedControl
        :model-value="props.config.floatingBallToolsDisplay"
        :options="toolsDisplayOptions"
        label="悬浮球按钮显示方式"
        :disabled="!enabled"
        @update:model-value="handleToolsDisplayChange"
      />
    </SettingsItem>

    <SettingsItem
      v-if="props.config.floatingBallToolsDisplay === 'hover'"
      label="展开延迟"
      description="鼠标停留多久后展开按钮；0 毫秒表示立即展开，调大可避免划过页面边缘时误展开。键盘聚焦始终立即展开。"
      :disabled="!enabled"
    >
      <div class="floating-ball-number-field">
        <el-input-number
          :model-value="props.config.floatingBallHoverDelay"
          aria-label="悬浮球展开延迟"
          :min="FLOATING_BALL_HOVER_DELAY_MIN"
          :max="FLOATING_BALL_HOVER_DELAY_MAX"
          :step="FLOATING_BALL_HOVER_DELAY_STEP"
          :disabled="!enabled"
          controls-position="right"
          @change="handleHoverDelayChange"
        />
        <span class="input-suffix">ms</span>
      </div>
    </SettingsItem>

    <SettingsItem
      label="点击行为"
      description="点击悬浮球本体时执行的动作；无论选择哪一项，按住悬浮球都可以拖动调整位置。"
      :disabled="!enabled"
    >
      <SegmentedControl
        :model-value="props.config.floatingBallClickAction"
        :options="clickActionOptions"
        label="悬浮球点击行为"
        :disabled="!enabled"
        @update:model-value="handleClickActionChange"
      />
    </SettingsItem>

    <SettingsItem
      label="缩小悬浮球"
      description="以更小的尺寸显示悬浮球，减少对网页内容的遮挡。"
      :disabled="!enabled"
    >
      <el-switch
        v-model="props.config.floatingBallCompact"
        class="settings-toggle"
        aria-label="缩小悬浮球"
        :disabled="!enabled"
      />
    </SettingsItem>

    <SettingsItem
      label="显示设置入口"
      description="关闭后悬浮球不再显示打开设置页的按钮，仍可从扩展图标进入设置。"
      :disabled="!enabled || props.config.floatingBallToolsDisplay === 'hidden'"
    >
      <el-switch
        v-model="props.config.floatingBallSettingsEntryVisible"
        class="settings-toggle"
        aria-label="悬浮球设置入口"
        :disabled="!enabled || props.config.floatingBallToolsDisplay === 'hidden'"
      />
    </SettingsItem>

    <SettingsItem
      label="收起时不透明度"
      description="数值越小越透明、越不遮挡网页；鼠标悬停、展开和拖动时始终完全清晰。"
      :disabled="!enabled"
    >
      <div class="floating-ball-number-field">
        <el-input-number
          :model-value="props.config.floatingBallCollapsedOpacity"
          aria-label="悬浮球收起时不透明度"
          :min="FLOATING_BALL_COLLAPSED_OPACITY_MIN"
          :max="FLOATING_BALL_COLLAPSED_OPACITY_MAX"
          :step="FLOATING_BALL_COLLAPSED_OPACITY_STEP"
          :disabled="!enabled"
          controls-position="right"
          @change="handleCollapsedOpacityChange"
        />
        <span class="input-suffix">%</span>
      </div>
    </SettingsItem>

    <AlwaysTranslateSites
      :model-value="props.config.floatingBallDisabledDomains"
      variant="disable-floating-ball"
      @update:model-value="handleDisabledDomainsChange"
    />
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed} from 'vue';
import type {Config, FloatingBallClickAction, FloatingBallToolsDisplay} from '@/src/core/config/model';
import {
  FLOATING_BALL_COLLAPSED_OPACITY_MAX,
  FLOATING_BALL_COLLAPSED_OPACITY_MIN,
  FLOATING_BALL_COLLAPSED_OPACITY_STEP,
  FLOATING_BALL_HOVER_DELAY_MAX,
  FLOATING_BALL_HOVER_DELAY_MIN,
  FLOATING_BALL_HOVER_DELAY_STEP,
  normalizeFloatingBallClickAction,
  normalizeFloatingBallCollapsedOpacity,
  normalizeFloatingBallHoverDelay,
  normalizeFloatingBallToolsDisplay,
} from '@/src/core/config/model';
import AlwaysTranslateSites from './AlwaysTranslateSites.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SegmentedControl from './components/SegmentedControl.vue';

const props = defineProps<{config: Config}>();

const enabled = computed(() => props.config.disableFloatingBall !== true);

const toolsDisplayOptions: {label: string; value: FloatingBallToolsDisplay}[] = [
  {label: '悬停时显示', value: 'hover'},
  {label: '始终显示', value: 'always'},
  {label: '不显示', value: 'hidden'},
];

const clickActionOptions: {label: string; value: FloatingBallClickAction}[] = [
  {label: '翻译/显示原文', value: 'translate'},
  {label: '打开设置', value: 'settings'},
  {label: '仅拖动', value: 'none'},
];

function handleToolsDisplayChange(value: string | number) {
  props.config.floatingBallToolsDisplay = normalizeFloatingBallToolsDisplay(value);
}

function handleClickActionChange(value: string | number) {
  props.config.floatingBallClickAction = normalizeFloatingBallClickAction(value);
}

function handleHoverDelayChange(value: number | undefined) {
  props.config.floatingBallHoverDelay = normalizeFloatingBallHoverDelay(value);
}

function handleCollapsedOpacityChange(value: number | undefined) {
  props.config.floatingBallCollapsedOpacity = normalizeFloatingBallCollapsedOpacity(value);
}

function handleDisabledDomainsChange(domains: string[]) {
  props.config.floatingBallDisabledDomains = domains;
}
</script>

<style scoped>
.floating-ball-number-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.floating-ball-number-field :deep(.el-input-number) {
  width: 124px;
}

.input-suffix {
  color: var(--muted);
  font-size: 11px;
}
</style>
