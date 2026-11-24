<!--
 * @file src/app/popup/PopupSiteRule.vue
 * 文件职责：渲染 Popup 的当前网站规则模块，使该区域既能保持默认嵌套视觉，也能作为独立模块参与用户布局排序。
 * 主要内容：紧凑展示始终翻译和禁用扩展两个开关，用悬停与无障碍说明交代网站范围及禁用优先级；保存期间独占规则，禁用可中断在途翻译，操作意图绑定当前页面、配置和活跃会话。
 * 模块边界：组件不读取标签页、不修改配置、不发送浏览器消息；域名解析、状态计算、保存与即时页面通知仍由 PopupApp 负责。
-->
<template>
  <div class="site-rule-row" data-popup-module="siteRule" :title="!props.supported ? t('popup.unsupportedPage') : undefined">
    <div class="site-rule-actions">
      <button
        class="site-rule-button"
        :class="{ enabled: props.alwaysTranslated, 'global-enabled': props.autoTranslate }"
        data-setting="always-translate-site"
        :data-site-domain="props.domain"
        :data-enabled="props.alwaysTranslated"
        type="button"
        role="switch"
        :aria-checked="props.alwaysTranslated"
        :aria-label="props.switchLabel"
        :aria-description="siteScopeHint"
        :aria-busy="props.saving"
        :title="`${props.switchLabel} · ${siteScopeHint}`"
        :disabled="!props.supported || props.translating || props.saving || props.autoTranslate || props.extensionDisabled"
        :onClick="actions.always"
      >
        <span>{{ props.alwaysPaused ? '自动翻译已暂停' : props.autoTranslate ? '全局自动翻译' : props.alwaysTranslated ? '始终翻译已开启' : '始终翻译此网站' }}</span>
        <i aria-hidden="true" :class="{'site-rule-saving': props.saving}" />
      </button>
      <button
        class="site-rule-button site-disable-rule-button"
        :class="{ enabled: props.extensionDisabled }"
        data-setting="disable-extension-site"
        :data-site-domain="props.domain"
        :data-enabled="props.extensionDisabled"
        type="button"
        role="switch"
        :aria-checked="props.extensionDisabled"
        :aria-label="props.extensionSwitchLabel"
        :aria-description="`${siteScopeHint}；${translateLegacy('禁用会停止此网站的翻译，保留始终翻译偏好')}`"
        :aria-busy="props.saving"
        :title="`${props.extensionSwitchLabel} · ${siteScopeHint} · ${translateLegacy('禁用优先于自动翻译')}`"
        :disabled="!props.supported || props.saving"
        :onClick="actions.disabled"
      >
        <span>{{ props.extensionDisabled ? '已禁用扩展' : '在此网站禁用扩展' }}</span>
        <i aria-hidden="true" :class="{'site-rule-saving': props.saving}" />
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import {computed} from 'vue';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {useUiI18n} from '@/src/ui/i18n';
const {t, translateLegacy} = useUiI18n();
const props = withDefaults(defineProps<{
  active?: boolean
  context?: unknown
  domain: string
  supported: boolean
  alwaysTranslated: boolean
  alwaysPaused?: boolean
  extensionDisabled: boolean
  autoTranslate: boolean
  translating: boolean
  saving?: boolean
  switchLabel: string
  extensionSwitchLabel: string
}>(), {active: true})

const emit = defineEmits<{
  'set-always-translated': [enabled: boolean]
  'set-extension-disabled': [enabled: boolean]
}>()
const {capture} = useSettingsActionContext(() => props.active && props.supported,
  () => [props.context, props.domain, props.alwaysTranslated, props.alwaysPaused, props.extensionDisabled, props.autoTranslate, props.translating, props.saving]);
const siteScopeHint = computed(() => translateLegacy('应用于此网站及其子域名，跳转后按新网站规则执行'));
const actions = computed(() => {
  const current = capture(), always = !props.alwaysTranslated, disabled = !props.extensionDisabled;
  return {always: () => {if (current() && !props.translating && !props.saving && !props.autoTranslate && !props.extensionDisabled) emit('set-always-translated', always)},
    disabled: () => {if (current() && !props.saving) emit('set-extension-disabled', disabled)}};
});
</script>
