<!--
 * @file src/features/settings/ui/FloatingBallSettings.vue
 * 文件职责：提供悬浮球的进阶外观与交互设置，把按钮显示方式、展开延迟、点击行为、紧凑尺寸、设置入口、收起不透明度、边距和禁用网站集中在一处编辑。
 * 主要内容：全部标签、选项和辅助说明使用稳定 i18n key；按扩展与脚本的真实入口区分“快捷面板”和“完整设置”，组件以分段控件和设置页统一的紧凑数值框呈现各字段，写入前统一调用 core/config 的归一化函数，悬浮球关闭时禁用全部控件，并复用站点名单编辑器维护不显示悬浮球的域名。
 * 模块边界：它只修改传入的配置对象，不发送标签页消息、不挂载悬浮球也不实现站点匹配；持久化由设置页统一触发，页面侧生效由悬浮球 content runtime 订阅配置完成。
 -->
<template>
  <SettingsGroup
    class="floating-ball-settings"
    :title="t('settings.floatingBall.title')"
    :description="enabled ? undefined : t('settings.floatingBall.disabledNote')"
  >
    <SettingsItem
      :label="t('settings.floatingBall.toolsDisplay')"
      :description="t('settings.floatingBall.toolsDisplayDescription')"
      :disabled="!enabled"
    >
      <SegmentedControl
        :model-value="props.config.floatingBallToolsDisplay"
        :options="toolsDisplayOptions"
        :label="t('settings.floatingBall.toolsDisplayAria')"
        :disabled="!enabled"
        @update:model-value="handleToolsDisplayChange"
      />
    </SettingsItem>

    <SettingsItem
      v-if="props.config.floatingBallToolsDisplay === 'hover'"
      :label="t('settings.floatingBall.hoverDelay')"
      :help="t('settings.floatingBall.hoverDelayHelp')"
      :disabled="!enabled"
    >
      <SettingsNumberInput
        :model-value="props.config.floatingBallHoverDelay"
        unit="ms"
        :aria-label="t('settings.floatingBall.hoverDelayAria')"
        :min="FLOATING_BALL_HOVER_DELAY_MIN"
        :max="FLOATING_BALL_HOVER_DELAY_MAX"
        :step="FLOATING_BALL_HOVER_DELAY_STEP"
        :disabled="!enabled"
        @change="handleHoverDelayChange"
      />
    </SettingsItem>

    <SettingsItem
      :label="t('settings.floatingBall.clickAction')"
      :description="t(isUserscript ? 'settings.floatingBall.clickDescriptionUserscript' : 'settings.floatingBall.clickDescription')"
      :disabled="!enabled"
    >
      <SegmentedControl
        :model-value="props.config.floatingBallClickAction"
        :options="clickActionOptions"
        :label="t('settings.floatingBall.clickAction')"
        :disabled="!enabled"
        @update:model-value="handleClickActionChange"
      />
    </SettingsItem>

    <SettingsItem
      :label="t('settings.floatingBall.compact')"
      :description="t('settings.floatingBall.compactDescription')"
      :disabled="!enabled"
    >
      <el-switch
        v-model="props.config.floatingBallCompact"
        class="settings-toggle"
        :aria-label="t('settings.floatingBall.compact')"
        :disabled="!enabled"
      />
    </SettingsItem>

    <SettingsItem
      :label="t('settings.floatingBall.settingsEntry')"
      :description="t(isUserscript ? 'settings.floatingBall.settingsEntryDescriptionUserscript' : 'settings.floatingBall.settingsEntryDescription')"
      :disabled="!enabled || props.config.floatingBallToolsDisplay === 'hidden'"
    >
      <el-switch
        v-model="props.config.floatingBallSettingsEntryVisible"
        class="settings-toggle"
        :aria-label="t('settings.floatingBall.settingsEntry')"
        :disabled="!enabled || props.config.floatingBallToolsDisplay === 'hidden'"
      />
    </SettingsItem>

    <SettingsItem
      v-if="props.config.floatingBallToolsDisplay !== 'always'"
      :label="t('settings.floatingBall.collapsedOpacity')"
      :description="t('settings.floatingBall.collapsedOpacityDescription')"
      :disabled="!enabled"
    >
      <SettingsNumberInput
        :model-value="props.config.floatingBallCollapsedOpacity"
        unit="%"
        :aria-label="t('settings.floatingBall.collapsedOpacityAria')"
        :min="FLOATING_BALL_COLLAPSED_OPACITY_MIN"
        :max="FLOATING_BALL_COLLAPSED_OPACITY_MAX"
        :step="FLOATING_BALL_COLLAPSED_OPACITY_STEP"
        :disabled="!enabled"
        @change="handleCollapsedOpacityChange"
      />
    </SettingsItem>

    <SettingsItem
      :label="t('settings.floatingBall.defaultMargin')"
      :description="t('settings.floatingBall.defaultMarginDescription')"
      :disabled="!enabled"
    >
      <SettingsNumberInput
        :model-value="props.config.floatingBallDefaultMargin"
        unit="px"
        :aria-label="t('settings.floatingBall.defaultMarginAria')"
        :min="FLOATING_BALL_MARGIN_MIN"
        :max="FLOATING_BALL_MARGIN_MAX"
        :step="FLOATING_BALL_MARGIN_STEP"
        :disabled="!enabled"
        @change="handleDefaultMarginChange"
      />
    </SettingsItem>

    <SettingsItem
      v-if="props.config.floatingBallToolsDisplay === 'hover'"
      :label="t('settings.floatingBall.popoutMargin')"
      :description="t('settings.floatingBall.popoutMarginDescription')"
      :disabled="!enabled"
    >
      <SettingsNumberInput
        :model-value="props.config.floatingBallPopoutMargin"
        unit="px"
        :aria-label="t('settings.floatingBall.popoutMarginAria')"
        :min="FLOATING_BALL_MARGIN_MIN"
        :max="FLOATING_BALL_MARGIN_MAX"
        :step="FLOATING_BALL_MARGIN_STEP"
        :disabled="!enabled"
        @change="handlePopoutMarginChange"
      />
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
  FLOATING_BALL_MARGIN_MAX,
  FLOATING_BALL_MARGIN_MIN,
  FLOATING_BALL_MARGIN_STEP,
  normalizeFloatingBallClickAction,
  normalizeFloatingBallCollapsedOpacity,
  normalizeFloatingBallHoverDelay,
  normalizeFloatingBallMargin,
  normalizeFloatingBallToolsDisplay,
} from '@/src/core/config/model';
import AlwaysTranslateSites from './AlwaysTranslateSites.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import SettingsNumberInput from './components/SettingsNumberInput.vue';
import {useUiI18n} from '@/src/ui/i18n';

const props = defineProps<{config: Config}>();

const {t} = useUiI18n();
const enabled = computed(() => props.config.disableFloatingBall !== true);
const isUserscript = import.meta.env.BROWSER === 'userscript';

const toolsDisplayOptions = computed<{label: string; value: FloatingBallToolsDisplay}[]>(() => [
  {label: t('settings.floatingBall.tools.hover'), value: 'hover'},
  {label: t('settings.floatingBall.tools.always'), value: 'always'},
  {label: t('settings.floatingBall.tools.hidden'), value: 'hidden'},
]);

const clickActionOptions = computed<{label: string; value: FloatingBallClickAction}[]>(() => [
  {label: t('settings.floatingBall.click.translate'), value: 'translate'},
  {label: t(isUserscript ? 'settings.floatingBall.click.settings' : 'settings.floatingBall.click.quickPanel'), value: 'settings'},
  {label: t('settings.floatingBall.click.none'), value: 'none'},
]);

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

function handleDefaultMarginChange(value: number | undefined) {
  props.config.floatingBallDefaultMargin = normalizeFloatingBallMargin(value);
}

function handlePopoutMarginChange(value: number | undefined) {
  props.config.floatingBallPopoutMargin = normalizeFloatingBallMargin(
    value,
    props.config.floatingBallPopoutMargin,
  );
}

function handleDisabledDomainsChange(domains: string[]) {
  props.config.floatingBallDisabledDomains = domains;
}
</script>

<style scoped>
/* 网站名单嵌在分组内时去掉自身的卡片外框，只保留与上方设置行之间的分隔线，避免卡片套卡片。 */
.floating-ball-settings :deep(.site-rules-editor) {
  width: 100%;
  margin: 0;
  border: 0;
  border-top: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
}
</style>
