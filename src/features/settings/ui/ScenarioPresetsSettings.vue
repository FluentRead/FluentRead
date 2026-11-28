<!--
 * @file src/features/settings/ui/ScenarioPresetsSettings.vue
 * 文件职责：在通用设置中提供“场景预设”紧凑入口与可展开预览面板，允许老用户随时多选阅读场景并一键非破坏性应用配置。
 * 主要内容：复用 core/config/scenarioPresets 的五类场景定义与补丁计算，展示待启用能力清单与“不覆盖 API Key 与自定义规则”说明，按活跃上下文与配置归属提交最小补丁并反馈成功或已满足提示。
 * 模块边界：只负责场景预设的交互预览与回调触发，不直接读写浏览器存储；实际配置提交通过父组件传入的 applyPatch 或直接更新绑定 config 完成。
-->
<template>
  <SettingsGroup
    :title="t('scenarioPresets.settings.title')"
    :description="t('scenarioPresets.settings.description')"
    data-testid="scenario-presets-settings"
  >
    <SettingsItem
      :label="t('scenarioPresets.settings.triggerLabel')"
      :description="t('scenarioPresets.settings.triggerDescription')"
    >
      <el-button
        size="small"
        data-testid="scenario-presets-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? t('scenarioPresets.settings.collapse') : t('scenarioPresets.settings.expand') }}
      </el-button>
    </SettingsItem>

    <div v-if="expanded" class="scenario-presets-panel" data-testid="scenario-presets-panel">
      <div class="scenario-presets-grid" role="group" :aria-label="t('scenarioPresets.settings.title')">
        <button
          v-for="preset in SCENARIO_PRESETS"
          :key="preset.id"
          type="button"
          class="scenario-preset-card"
          :class="{ 'is-selected': selectedIds.includes(preset.id) }"
          :aria-pressed="selectedIds.includes(preset.id)"
          :data-scenario-id="preset.id"
          @click="toggleScenario(preset.id)"
        >
          <span class="scenario-preset-card-head">
            <strong>{{ t(preset.titleKey) }}</strong>
            <span class="scenario-preset-check" aria-hidden="true">✓</span>
          </span>
          <span class="scenario-preset-card-desc">{{ t(preset.descriptionKey) }}</span>
        </button>
      </div>

      <div v-if="preview.scenarioIds.length > 0" class="scenario-presets-preview" data-testid="scenario-presets-preview">
        <div class="scenario-presets-preview-title">{{ t('scenarioPresets.preview.title') }}</div>
        <ul class="scenario-presets-preview-list">
          <li v-for="featureKey in preview.featureSummaryKeys" :key="featureKey">{{ t(featureKey) }}</li>
        </ul>
        <p class="scenario-presets-safety">{{ t('scenarioPresets.preview.safeNote') }}</p>
      </div>

      <div class="scenario-presets-actions">
        <el-button
          type="primary"
          size="small"
          data-testid="scenario-presets-apply"
          :disabled="preview.scenarioIds.length === 0 || applying"
          @click="applySelectedPresets"
        >
          {{ t('scenarioPresets.settings.applyButton') }}
        </el-button>
        <el-button
          v-if="selectedIds.length > 0"
          size="small"
          text
          data-testid="scenario-presets-clear"
          :disabled="applying"
          @click="selectedIds = []"
        >
          {{ t('scenarioPresets.settings.clearSelection') }}
        </el-button>
      </div>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue';
import {ElMessage} from 'element-plus';
import type {Config} from '@/src/core/config/model';
import {
    buildScenarioPresetPatch,
    SCENARIO_PRESETS,
    type ScenarioPresetId,
} from '@/src/core/config/scenarioPresets';
import {useUiI18n} from '@/src/ui/i18n';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';

const props = withDefaults(defineProps<{
    config: Config;
    active?: boolean;
    applyPatch?: (patch: Partial<Config>) => Promise<void> | void;
}>(), {active: true});

const {t} = useUiI18n();
const context = useSettingsActionContext(() => props.active, () => [props.config]);
const expanded = ref(false);
const selectedIds = ref<ScenarioPresetId[]>([]);
const applying = ref(false);

const preview = computed(() => buildScenarioPresetPatch(selectedIds.value, props.config));

function toggleScenario(id: ScenarioPresetId): void {
    if (applying.value) return;
    if (selectedIds.value.includes(id)) {
        selectedIds.value = selectedIds.value.filter((item) => item !== id);
    } else {
        selectedIds.value = [...selectedIds.value, id];
    }
}

async function applySelectedPresets(): Promise<void> {
    if (!context.active.value || applying.value || preview.value.scenarioIds.length === 0) return;
    const current = context.capture();
    const result = buildScenarioPresetPatch(selectedIds.value, props.config);
    if (result.alreadySatisfied) {
        ElMessage.info(t('scenarioPresets.settings.alreadySatisfied'));
        return;
    }
    applying.value = true;
    try {
        if (props.applyPatch) {
            await props.applyPatch(result.patch);
        } else {
            Object.assign(props.config, result.patch);
        }
        if (!current()) return;
        ElMessage.success(t('scenarioPresets.settings.applied'));
    } catch {
        if (current()) ElMessage.error(t('scenarioPresets.settings.saveFailed'));
    } finally {
        applying.value = false;
    }
}
</script>

<style scoped>
.scenario-presets-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}

.scenario-presets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}

.scenario-preset-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--line, #e2e8f0);
  border-radius: 10px;
  background: var(--surface-soft, #f8fafc);
  color: var(--ink, #172033);
  text-align: left;
  cursor: pointer;
}

.scenario-preset-card.is-selected {
  border-color: var(--brand, #2563eb);
  background: var(--brand-soft, #eff6ff);
}

.scenario-preset-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.scenario-preset-check {
  color: var(--brand, #2563eb);
  visibility: hidden;
  font-weight: 700;
}

.scenario-preset-card.is-selected .scenario-preset-check {
  visibility: visible;
}

.scenario-preset-card-desc {
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted, #64748b);
}

.scenario-presets-preview {
  padding: 10px 12px;
  border: 1px dashed var(--line, #cbd5e1);
  border-radius: 10px;
  background: var(--surface, #ffffff);
}

.scenario-presets-preview-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.scenario-presets-preview-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink, #172033);
}

.scenario-presets-safety {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--muted, #64748b);
}

.scenario-presets-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
