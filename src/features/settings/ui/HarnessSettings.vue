<!--
 * @file src/features/settings/ui/HarnessSettings.vue
 * 文件职责：作为划词翻译的 AI 深入讲解子设置，关闭时收起全部下属配置，开启后清晰组织学习动作、回答偏好、上下文、学习记忆与按需展开的自定义指令。
 * 主要内容：翻译服务统一在通用设置中分配，此处仅展示生效服务与模型覆盖；去除静态示例预览与跨页跳转按钮，自定义指令收进折叠区。
 * 模块边界：服务候选与能力校验遵循共享规则；只编辑传入 Config 的 harness 字段，不发起模型请求、不拥有网页选区。
 -->
<template>
  <SettingsGroup data-settings-anchor="learning" data-settings-anchor-label="AI 深入讲解">
    <FeatureEnableCard v-model="config.harness.enabled" title="AI 深入讲解" description="在划词卡片中按需读懂、拆句、学用法或练习；关闭后仍可正常翻译和查词" />

    <template v-if="config.harness.enabled">
      <SettingsItem label="讲解模型" :description="modelDescription">
        <div v-if="isBilibiliReading" class="harness-fixed-model" aria-label="学习讲解模型" data-i18n-ignore>{{ effectiveModel.model }}</div>
        <el-select v-else v-model="config.harness.model" class="harness-select" clearable filterable allow-create default-first-option aria-label="学习讲解模型" placeholder="跟随服务模型" :disabled="!effectiveServiceSupportsHarness">
          <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
        </el-select>
        <small v-if="!effectiveServiceSupportsHarness" id="harness-service-hint" class="service-hint" role="status">{{ t('settings.harness.unsupportedService') }}</small>
      </SettingsItem>

      <SettingsItem label="卡片中的学习动作" stacked>
        <div class="harness-actions">
          <label v-for="action in HARNESS_ACTIONS" :key="action.id" class="harness-action" :class="{selected: config.harness.actions.includes(action.id), unavailable: !isReadingActionSupported(effectiveModel.service, action.id)}">
            <input type="checkbox" :checked="config.harness.actions.includes(action.id)" :disabled="action.id === 'meaning' || !isReadingActionSupported(effectiveModel.service, action.id)" @change="toggleAction(action.id)" />
            <span><strong>{{ action.label }}<em v-if="action.id === 'meaning'">固定显示</em></strong><small>{{ isReadingActionSupported(effectiveModel.service, action.id) ? action.description : '当前服务暂不支持' }}</small></span>
          </label>
        </div>
      </SettingsItem>

      <SettingsItem class="harness-default-action" label="默认学习动作">
        <el-select v-model="effectiveDefaultAction" class="harness-select" aria-label="默认动作">
          <el-option v-for="action in visibleActions" :key="action.id" :label="action.label" :value="action.id" />
        </el-select>
      </SettingsItem>

      <SettingsItem label="回答长度">
        <SegmentedControl v-model="config.harness.explanationDepth" :options="explanationDepthOptions" label="解释深度" />
      </SettingsItem>

      <SettingsItem label="学习程度">
        <SegmentedControl v-model="config.harness.learningLevel" :options="learningLevelOptions" label="学习程度" />
      </SettingsItem>

      <SettingsItem label="结合哪些原文" :description="config.harness.contextMode === 'paragraph' ? '参考所选文字所在的段落，不读取整页' : '只发送选中的文字'">
        <SegmentedControl v-model="config.harness.contextMode" :options="contextModeOptions" label="上下文范围" />
      </SettingsItem>

      <SettingsItem v-if="config.harness.contextMode === 'paragraph'" label="段落长度上限">
        <SettingsNumberInput v-model="config.harness.maxContextChars" unit="字符" :min="500" :max="4000" :step="100" aria-label="上下文上限" />
      </SettingsItem>

      <SettingsItem :label="t('settings.memoryEnabled')" :description="t('settings.memoryDescription')">
        <el-switch v-model="config.harness.memoryEnabled" :aria-label="t('settings.memoryEnabled')" />
      </SettingsItem>
    </template>
  </SettingsGroup>

  <SettingsDisclosure
    v-if="config.harness.enabled"
    data-settings-anchor="instructions"
    :data-settings-anchor-label="t('settings.selection.instructionsTitle')"
    :title="t('settings.selection.instructionsTitle')"
    :status="hasCustomPrompts ? t('settings.disclosure.customized') : t('settings.disclosure.default')"
  >
    <HarnessPromptSettings :preferences="config.harness" />
  </SettingsDisclosure>
</template>
<script setup lang="ts">
import HarnessPromptSettings from './HarnessPromptSettings.vue';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import {computed, toRef} from 'vue';
import {models, options, resolveConfiguredModel, services} from '@/src/core/config/catalog';
import {getCustomOpenAIProviderLabel, getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {HARNESS_ACTIONS, isReadingActionSupported, isReadingService, resolveHarnessModel, type HarnessActionId} from '@/src/core/config/harness';
import type {Config} from '@/src/core/config/model';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsDisclosure from './components/SettingsDisclosure.vue';
import SettingsItem from './components/SettingsItem.vue';
import SettingsNumberInput from './components/SettingsNumberInput.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import {useUiI18n} from '@/src/ui/i18n';

const props = defineProps<{config: Config}>();
const config = toRef(props, 'config');
const {t, translateLegacy} = useUiI18n();

const activeService = computed(() => config.value.harness.service || config.value.service);
const activeServiceLabel = computed(() => {
  const id = activeService.value;
  if (id === services.bilibili) return 'B站翻译 · 免费';
  const builtin = options.services.find(item => item.value === id);
  if (builtin) return translateLegacy(builtin.label);
  return getCustomOpenAIProviderLabel(config.value.customOpenAIProviders, id) || id;
});
const modelOptions = computed(() => {
  const service = activeService.value;
  if (service === services.chatgptPlan) return [...new Set([
    resolveConfiguredModel(config.value.model[service], config.value.customModel[service]),
    config.value.harness.model,
  ].filter(Boolean))];
  return (isCustomOpenAIProviderId(service) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service) : models.get(service) || []).filter((model) => model !== '自定义模型');
});
const effectiveServiceSupportsHarness = computed(() => isReadingService(activeService.value, config.value.customOpenAIProviders));
const effectiveModel = computed(() => resolveHarnessModel(config.value));
const isBilibiliReading = computed(() => effectiveModel.value.service === services.bilibili);
const modelDescription = computed(() => isBilibiliReading.value
  ? `${activeServiceLabel.value} · 免费基础读懂/用法；${t('settings.serviceManagedInGeneral')}`
  : `${activeServiceLabel.value} · ${t('settings.serviceManagedInGeneral')}`);
const visibleActions = computed(() => HARNESS_ACTIONS.filter((action) => config.value.harness.actions.includes(action.id) && isReadingActionSupported(effectiveModel.value.service, action.id)));
const effectiveDefaultAction = computed({
  get: () => visibleActions.value.find(action => action.id === config.value.harness.defaultAction)?.id
    || visibleActions.value.find(action => action.id === 'meaning')?.id || visibleActions.value[0]?.id || 'meaning',
  set: (action: HarnessActionId) => { if (visibleActions.value.some(item => item.id === action)) config.value.harness.defaultAction = action; },
});
const hasCustomPrompts = computed(() => Boolean(
  config.value.harness.systemPrompt?.trim()
  || Object.values(config.value.harness.actionPrompts || {}).some(item => item?.trim()),
));
const contextModeOptions = [{value: 'paragraph', label: '可参考本段'}, {value: 'selection', label: '仅选中文字'}];
const explanationDepthOptions = [{value: 'concise', label: '简洁'}, {value: 'detailed', label: '详细'}];
const learningLevelOptions = [{value: 'beginner', label: '初级'}, {value: 'intermediate', label: '中级'}, {value: 'advanced', label: '高级'}];

function toggleAction(id: HarnessActionId) {
  if (id === 'meaning' || !isReadingActionSupported(effectiveModel.value.service, id)) return;
  const actions = config.value.harness.actions.includes(id) ? config.value.harness.actions.filter((item) => item !== id) : [...config.value.harness.actions, id];
  config.value.harness.actions = actions.includes('meaning') ? actions : ['meaning', ...actions];
  if (!config.value.harness.actions.includes(config.value.harness.defaultAction)) config.value.harness.defaultAction = 'meaning';
}
</script>

<style scoped>
.service-hint { width: 100%; font-size: 12px; line-height: 1.5; color: var(--fr-warning); }
.harness-fixed-model { min-height: 36px; width: 100%; max-width: 360px; display: flex; align-items: center; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); color: var(--ink); font-size: 12.5px; overflow-wrap: anywhere; }
.harness-select { width: 100%; }
.harness-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; width: 100%; }
.harness-action { display: flex; gap: 8px; align-items: flex-start; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px; cursor: pointer; }
.harness-action.selected { border-color: color-mix(in srgb, var(--brand) 45%, var(--line)); background: color-mix(in srgb, var(--brand) 4%, var(--surface)); }
.harness-action.unavailable { cursor: default; opacity: .6; }
.harness-action input { accent-color: var(--brand); margin: 3px 0 0; }
.harness-action span { display: flex; flex-direction: column; gap: 4px; color: var(--ink); font-size: 12px; }
.harness-action strong { display: flex; flex-wrap: wrap; gap: 4px 8px; }
.harness-action em { color: var(--muted); font-size: 10px; font-style: normal; font-weight: 400; }
.harness-action small { color: var(--muted); font-size: 11px; line-height: 1.5; }
@media (max-width: 560px) { .harness-actions { grid-template-columns: minmax(0, 1fr); } }
</style>
