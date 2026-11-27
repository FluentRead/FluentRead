<!--
 * @file src/features/settings/ui/FloatingBallSettings.vue
 * 文件职责：提供悬浮球的完整开关与分层设置，将常用交互与位置/外观微调分层展示，按网站隐藏统一收归网站规则。
 * 主要内容：顶部总开关控制 disableFloatingBall，关闭时收起下属配置；开启后优先展示点击行为、按钮显示方式、紧凑尺寸与设置入口，展开延迟、收起不透明度及边距收进可按需展开的微调分组；全部文案使用稳定 i18n key，写入前调用 core/config 归一化函数。
 * 模块边界：只修改传入的配置对象，不发送标签页消息、不挂载悬浮球也不重复维护站点名单；持久化由设置页统一触发，页面侧生效由悬浮球 content runtime 订阅配置完成。
 -->
<template>
  <SettingsGroup class="floating-ball-settings">
    <FeatureEnableCard
      id="floating-ball-toggle"
      v-model="enabled"
      :title="t('settings.general.floatingBall')"
      :description="t('settings.general.floatingBallDescription')"
    />

    <template v-if="enabled">
      <SettingsItem
        :label="t('settings.floatingBall.clickAction')"
        :description="t(isUserscript ? 'settings.floatingBall.clickDescriptionUserscript' : 'settings.floatingBall.clickDescription')"
      >
        <SegmentedControl
          :model-value="props.config.floatingBallClickAction"
          :options="clickActionOptions"
          :label="t('settings.floatingBall.clickAction')"
          @update:model-value="handleClickActionChange"
        />
      </SettingsItem>

      <SettingsItem
        :label="t('settings.floatingBall.toolsDisplay')"
        :description="t('settings.floatingBall.toolsDisplayDescription')"
      >
        <SegmentedControl
          :model-value="props.config.floatingBallToolsDisplay"
          :options="toolsDisplayOptions"
          :label="t('settings.floatingBall.toolsDisplayAria')"
          @update:model-value="handleToolsDisplayChange"
        />
      </SettingsItem>

      <SettingsItem
        :label="t('settings.floatingBall.compact')"
        :description="t('settings.floatingBall.compactDescription')"
      >
        <el-switch
          v-model="props.config.floatingBallCompact"
          class="settings-toggle"
          :aria-label="t('settings.floatingBall.compact')"
        />
      </SettingsItem>

      <SettingsItem
        v-if="props.config.floatingBallClickAction !== 'settings'"
        :label="t('settings.floatingBall.settingsEntry')"
        :description="t(isUserscript ? 'settings.floatingBall.settingsEntryDescriptionUserscript' : 'settings.floatingBall.settingsEntryDescription')"
        :disabled="props.config.floatingBallToolsDisplay === 'hidden'"
      >
        <el-switch
          v-model="props.config.floatingBallSettingsEntryVisible"
          class="settings-toggle"
          :aria-label="t('settings.floatingBall.settingsEntry')"
          :disabled="props.config.floatingBallToolsDisplay === 'hidden'"
        />
      </SettingsItem>

      <details class="floating-ball-advanced" data-testid="floating-ball-advanced">
        <summary>
          <span>{{ t('settings.floatingBall.advancedTitle') }}</span>
          <small>{{ advancedStatus }}</small>
        </summary>
        <div class="floating-ball-advanced-body">
          <SettingsItem
            v-if="props.config.floatingBallToolsDisplay === 'hover'"
            :label="t('settings.floatingBall.hoverDelay')"
            :help="t('settings.floatingBall.hoverDelayHelp')"
          >
            <SettingsNumberInput
              :model-value="props.config.floatingBallHoverDelay"
              unit="ms"
              :aria-label="t('settings.floatingBall.hoverDelayAria')"
              :min="FLOATING_BALL_HOVER_DELAY_MIN"
              :max="FLOATING_BALL_HOVER_DELAY_MAX"
              :step="FLOATING_BALL_HOVER_DELAY_STEP"
              @change="handleHoverDelayChange"
            />
          </SettingsItem>

          <SettingsItem
            v-if="props.config.floatingBallToolsDisplay !== 'always'"
            :label="t('settings.floatingBall.collapsedOpacity')"
            :description="t('settings.floatingBall.collapsedOpacityDescription')"
          >
            <SettingsNumberInput
              :model-value="props.config.floatingBallCollapsedOpacity"
              unit="%"
              :aria-label="t('settings.floatingBall.collapsedOpacityAria')"
              :min="FLOATING_BALL_COLLAPSED_OPACITY_MIN"
              :max="FLOATING_BALL_COLLAPSED_OPACITY_MAX"
              :step="FLOATING_BALL_COLLAPSED_OPACITY_STEP"
              @change="handleCollapsedOpacityChange"
            />
          </SettingsItem>

          <SettingsItem
            :label="t('settings.floatingBall.defaultMargin')"
            :description="t('settings.floatingBall.defaultMarginDescription')"
          >
            <SettingsNumberInput
              :model-value="props.config.floatingBallDefaultMargin"
              unit="px"
              :aria-label="t('settings.floatingBall.defaultMarginAria')"
              :min="FLOATING_BALL_MARGIN_MIN"
              :max="FLOATING_BALL_MARGIN_MAX"
              :step="FLOATING_BALL_MARGIN_STEP"
              @change="handleDefaultMarginChange"
            />
          </SettingsItem>

          <SettingsItem
            v-if="props.config.floatingBallToolsDisplay === 'hover'"
            :label="t('settings.floatingBall.popoutMargin')"
            :description="t('settings.floatingBall.popoutMarginDescription')"
          >
            <SettingsNumberInput
              :model-value="props.config.floatingBallPopoutMargin"
              unit="px"
              :aria-label="t('settings.floatingBall.popoutMarginAria')"
              :min="FLOATING_BALL_MARGIN_MIN"
              :max="FLOATING_BALL_MARGIN_MAX"
              :step="FLOATING_BALL_MARGIN_STEP"
              @change="handlePopoutMarginChange"
            />
          </SettingsItem>
        </div>
      </details>

      <p class="floating-ball-site-note">{{ t('settings.floatingBall.siteRulesHint') }}</p>
    </template>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed} from 'vue';
import type {Config, FloatingBallClickAction, FloatingBallToolsDisplay} from '@/src/core/config/model';
import {
  DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY,
  DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
  DEFAULT_FLOATING_BALL_HOVER_DELAY,
  DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
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
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import SettingsNumberInput from './components/SettingsNumberInput.vue';
import {useUiI18n} from '@/src/ui/i18n';

const props = defineProps<{config: Config}>();
const emit = defineEmits<{toggle: [enabled: boolean]}>();

const {t} = useUiI18n();
const enabled = computed({
  get: () => props.config.disableFloatingBall !== true,
  set: (value: boolean) => {
    props.config.disableFloatingBall = !value;
    emit('toggle', value);
  },
});
const isUserscript = import.meta.env.BROWSER === 'userscript';

const advancedCustomized = computed(() =>
  props.config.floatingBallHoverDelay !== DEFAULT_FLOATING_BALL_HOVER_DELAY
  || props.config.floatingBallCollapsedOpacity !== DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY
  || props.config.floatingBallDefaultMargin !== DEFAULT_FLOATING_BALL_DEFAULT_MARGIN
  || props.config.floatingBallPopoutMargin !== DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
);
const advancedStatus = computed(() => t(advancedCustomized.value ? 'settings.disclosure.customized' : 'settings.disclosure.default'));

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
</script>

<style scoped>
.floating-ball-advanced {
  border-top: 1px solid var(--line);
}
.floating-ball-advanced > summary {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: var(--fr-settings-row-padding-block, 14px) var(--fr-card-padding-inline, 20px) !important;
  border: 0 !important;
  border-radius: 0 !important;
  font-size: 13px;
  font-weight: 550;
}
.floating-ball-advanced > summary small {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
  font-weight: 450;
}
.floating-ball-advanced[open] > summary {
  margin-bottom: 0 !important;
  border-bottom: 1px solid var(--line) !important;
}
.floating-ball-advanced-body > :deep(.settings-item + .settings-item) {
  border-top: 1px solid var(--line);
}
.floating-ball-site-note {
  margin: 0;
  padding: 12px var(--fr-card-padding-inline, 20px) 14px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
}
</style>
