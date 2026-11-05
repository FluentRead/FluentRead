<!--
 * @file src/features/settings/ui/AreaTranslationSettings.vue
 * 文件职责：提供图片翻译内的圈选区域设置，组织触发快捷键、识别与翻译的常用选择，并按需提供提示词和本地语言包设置。
 * 主要内容：紧凑模式只展示一个开关标题，详细选项按需展开；复用设置行和品牌按钮，提供预设与自定义录制的圈选快捷键及两点选取等入口的占用提示，显示当前模型识图能力，通过所属编辑弹窗即时修改识图提示词；隐藏、配置变更或缓存停用时释放草稿、缓存监听和 OCR 子界面。
 * 模块边界：只修改父级配置并发出开关事件；配置持久化由 SettingsSections 负责，快捷键解析与归一化归 core，不截图、不调用模型、不下载识别资源。
 -->
<template>
  <SettingsGroup :class="{'area-settings-compact': props.compact}" :title="props.compact ? undefined : t('area.settings.title')" :description="props.compact ? undefined : t('area.settings.intro')">
    <p v-if="!browserCapabilities.areaTranslation" class="area-settings-note" role="status">{{ t('area.settings.unavailable') }}</p>
    <FeatureEnableCard :model-value="props.enabled" :title="t(props.compact ? 'area.settings.title' : 'area.settings.enabled')" :description="t('area.settings.shortcut', {shortcut: hotkeyDisplayName})" :disabled="!browserCapabilities.areaTranslation" @update:model-value="emit('update:enabled', $event)" />
    <div class="area-translation-details">
    <SettingsItem :label="t('area.settings.hotkey')" :description="t('area.settings.hotkeyDescription')" :disabled="!browserCapabilities.areaTranslation">
      <div class="hotkey-config">
        <el-select :model-value="props.config.selectionAreaHotkey" :aria-label="t('area.settings.hotkey')" :disabled="!browserCapabilities.areaTranslation" @change="handleHotkeyChange">
          <el-option v-for="item in AREA_TRANSLATION_HOTKEY_OPTIONS" :key="item.value" :value="item.value" :label="item.label" data-i18n-ignore />
          <el-option value="custom" :label="t('area.settings.hotkeyCustom')" />
        </el-select>
        <div v-if="props.config.selectionAreaHotkey === 'custom'" class="area-hotkey-custom">
          <span v-if="props.config.customSelectionAreaHotkey" class="area-hotkey-text" data-i18n-ignore>{{ hotkeyDisplayName }}</span>
          <span v-else class="area-hotkey-text area-hotkey-placeholder">{{ t('area.settings.hotkeyCustomEmpty') }}</span>
          <el-button size="small" type="text" :aria-label="t('area.settings.hotkeyEdit')" :title="t('area.settings.hotkeyEdit')" @click="openCustomHotkeyDialog">
            <el-icon><Edit /></el-icon>
          </el-button>
        </div>
      </div>
    </SettingsItem>
    <SettingsItem :label="t('area.settings.service')" :description="serviceDescription">
      <el-select v-model="props.config.areaTranslationService" :aria-label="t('area.settings.service')" :placeholder="t('area.settings.followService')">
        <el-option :value="''" :label="t('area.settings.followService')" />
        <el-option v-if="savedServiceUnavailable" :value="props.config.areaTranslationService" :label="props.config.areaTranslationService" disabled />
        <el-option v-for="item in props.serviceOptions" :key="item.value" :value="item.value" :label="item.label" :disabled="item.disabled" />
      </el-select>
    </SettingsItem>
    <p v-if="unavailableMessage" class="area-settings-note area-settings-warning" role="status">{{ unavailableMessage }}</p>
    <SettingsItem :label="t('area.settings.recognitionMode')" :description="t(prefersVision ? capabilityMessageKey : 'area.settings.recognitionModeDescription')" :help="t(prefersVision ? 'area.settings.visionPrivacy' : 'area.settings.privacy')">
      <el-select v-model="props.config.areaRecognitionMode" data-testid="area-recognition-mode" :aria-label="t('area.settings.recognitionMode')">
        <el-option value="prefer-vision" :label="t('area.settings.recognitionVision')" />
        <el-option value="ocr" :label="t('area.settings.recognitionOcr')" />
      </el-select>
    </SettingsItem>
    <SettingsItem :label="t('area.settings.mode')">
      <template #description>
        <small v-if="!supportsAI" :class="{'area-settings-warning': props.config.areaTranslationMode === 'ai'}" role="status">{{ t('area.settings.chooseAI') }}</small>
        <small v-else>{{ t(props.config.areaTranslationMode === 'ai' ? 'area.settings.aiDescription' : 'area.settings.standardDescription') }}</small>
      </template>
      <el-select v-model="props.config.areaTranslationMode" :aria-label="t('area.settings.mode')">
        <el-option value="standard" :label="t('area.settings.standard')" />
        <el-option value="ai" :label="t('area.settings.ai')" :disabled="!supportsAI" />
      </el-select>
    </SettingsItem>
    <SettingsItem v-if="prefersVision" :label="t('area.settings.visionPrompt')" :description="t('area.settings.visionPromptDescription')">
      <el-button plain @click="openVisionPromptEditor">{{ t('area.settings.editVisionPrompt') }}</el-button>
    </SettingsItem>
    </div>
  </SettingsGroup>
  <details v-if="props.showOcr !== false" class="area-ocr-details" :open="!prefersVision">
    <summary>{{ t('area.settings.ocrDetails') }}</summary>
    <ImageOcrSettings v-if="hotkeyEditorActive" id-prefix="area" v-model:source-language="props.config.from" />
  </details>
  <el-dialog v-model="promptEditorOpen" :title="t('area.settings.visionPrompt')" width="min(640px, calc(100vw - 32px))" append-to-body destroy-on-close>
    <p class="area-prompt-description">{{ t('area.settings.visionPromptDescription') }}</p>
    <el-input :model-value="props.config.areaVisionPrompt" data-testid="area-vision-prompt" type="textarea" :rows="8" :aria-label="t('area.settings.visionPrompt')" @update:model-value="updateVisionPrompt" />
    <template #footer>
      <div class="area-prompt-actions">
        <el-button text @click="updateVisionPrompt(DEFAULT_AREA_VISION_PROMPT)">{{ t('area.settings.restorePrompt') }}</el-button>
        <el-button type="primary" @click="promptEditorOpen = false">{{ t('area.settings.promptDone') }}</el-button>
      </div>
    </template>
  </el-dialog>
  <CustomHotkeyInput
    v-model="showCustomHotkeyDialog"
    :current-value="props.config.customSelectionAreaHotkey"
    :validate="findHotkeyConflict"
    @confirm="handleCustomHotkeyConfirm"
    @cancel="handleCustomHotkeyCancel"
  />
</template>

<script setup lang="ts">
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import {computed, defineAsyncComponent, ref, watch} from 'vue';
import {Edit} from '@element-plus/icons-vue';
import {ElMessage} from 'element-plus';
import type {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {DEFAULT_AREA_VISION_PROMPT} from '@/src/core/config/vision';
import {
    areaTranslationHotkeyDisplayName,
    AREA_TRANSLATION_HOTKEY_OPTIONS,
    DEFAULT_AREA_TRANSLATION_HOTKEY,
} from '@/src/core/config/areaTranslation';
import {canonicalizeHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {resolveSectionTranslationHotkey} from '@/src/core/config/sectionTranslation';
import {resolveReservedClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {resolveParagraphCopyHotkey} from '@/src/core/config/paragraphCopy';
import {
    findEnabledQuickTranslationHotkeyConflict,
    quickTranslationActionKey,
    inputBoxTranslationTriggerHotkey,
} from '@/src/core/config/quickTranslation';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';
import {ImageOcrSettings} from '@/src/features/image-translation/ui/public';
import {useVisionProbeStatus} from './services/useVisionProbeStatus';
import {useUiI18n} from '@/src/ui/i18n';
import {useHotkeyDraft} from './useHotkeyDraft';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));

const props = defineProps<{
  config: Config;
  enabled: boolean;
  active: boolean;
  showOcr?: boolean;
  compact?: boolean;
  serviceOptions: readonly {value: string; label: string; disabled?: boolean}[];
}>();
const emit = defineEmits<{'update:enabled': [enabled: boolean]}>();
const {t, translateLegacy} = useUiI18n();
const {active: hotkeyEditorActive, showCustomHotkeyDialog, isCurrentDraft, openCustomHotkeyDialog, closeCustomHotkeyDialog, commitHotkeyDraft} = useHotkeyDraft(
    () => props.config, {mode: 'selectionAreaHotkey', custom: 'customSelectionAreaHotkey'}, () => props.active && browserCapabilities.areaTranslation, () => props.enabled,
);
const hotkeyDisplayName = computed(() => areaTranslationHotkeyDisplayName(
    props.config.selectionAreaHotkey,
    props.config.customSelectionAreaHotkey,
));

/** 列出已被其他功能占用的快捷键，避免两个功能同时响应同一个组合键。 */
function reservedHotkeyOwners(): {hotkey: string; feature: string}[] {
    return [
        {hotkey: resolveReservedClickSelectionHotkey(props.config), feature: translateLegacy('两点选取')},
        {hotkey: resolveConfiguredHotkey(props.config.hotkey, props.config.customHotkey), feature: t('popup.hoverTranslation')},
        {hotkey: resolveConfiguredHotkey(props.config.floatingBallHotkey, props.config.customFloatingBallHotkey), feature: t('quickTranslation.commonFullPageShortcut')},
        {
            // 划词已停用时它的旧快捷键不再接管按键，不应阻止圈选使用同一个组合键。
            hotkey: props.config.selectionTranslatorMode === 'disabled'
                ? ''
                : resolveConfiguredHotkey(props.config.selectionTranslatorTrigger, props.config.customSelectionTranslatorHotkey),
            feature: t('popup.selectionTranslation'),
        },
        {
            hotkey: props.config.sectionTranslationHotkeyEnabled
                ? resolveSectionTranslationHotkey(props.config.sectionTranslationHotkey, props.config.customSectionTranslationHotkey)
                : '',
            feature: t('sectionTranslation.settings.title'),
        },
        {
            hotkey: props.config.paragraphCopyEnabled
                ? resolveParagraphCopyHotkey(props.config.paragraphCopyHotkey, props.config.customParagraphCopyHotkey)
                : '',
            feature: t('paragraphCopy.settings.title'),
        },
        {hotkey: inputBoxTranslationTriggerHotkey(props.config.inputBoxTranslationTrigger), feature: translateLegacy('输入框翻译')},
    ];
}

/** 供自定义录制对话框实时校验；返回空字符串表示可以使用。 */
function findHotkeyConflict(hotkey: string): string {
    const resolved = canonicalizeHotkey(hotkey) || DEFAULT_AREA_TRANSLATION_HOTKEY;
    const identity = resolved.toLocaleLowerCase();
    const owner = reservedHotkeyOwners().find(item => canonicalizeHotkey(item.hotkey).toLocaleLowerCase() === identity);
    if (owner) return t('area.settings.hotkeyConflict', {feature: owner.feature});
    const profile = findEnabledQuickTranslationHotkeyConflict(props.config.quickTranslationProfiles, resolved);
    if (!profile) return '';
    return t('quickTranslation.conflictProfile', {
        group: t(`quickTranslation.heading.${quickTranslationActionKey(profile.action)}`),
    });
}

function handleHotkeyChange(value: string): void {
    if (!hotkeyEditorActive.value) return;
    if (value === 'custom' && !props.config.customSelectionAreaHotkey) {openCustomHotkeyDialog();return;}
    const conflict = findHotkeyConflict(value === 'custom' ? props.config.customSelectionAreaHotkey : value);
    if (conflict) {ElMessage.warning(conflict);return;}
    closeCustomHotkeyDialog();
    props.config.selectionAreaHotkey = value;
}

function handleCustomHotkeyConfirm(hotkey: string): void {
    if (!isCurrentDraft()) {closeCustomHotkeyDialog();return;}
    const canonical = canonicalizeHotkey(hotkey);
    if (findHotkeyConflict(canonical)) return;
    // 清除录制回到默认入口；提交前同样校验默认组合的占用。
    if (!commitHotkeyDraft(canonical ? 'custom' : DEFAULT_AREA_TRANSLATION_HOTKEY, canonical)) return;
    ElMessage({message: t('area.settings.hotkeySet', {shortcut: hotkeyDisplayName.value}), type: 'success', duration: 2000});
}

function handleCustomHotkeyCancel(): void {
    closeCustomHotkeyDialog();
}
const service = computed(() => props.config.areaTranslationService || props.config.service);
const model = computed(() => resolveConfiguredModel(props.config.model[service.value], props.config.customModel[service.value]));
const serviceDescription = computed(() => model.value
  ? `${props.serviceOptions.find(item => item.value === service.value)?.label || service.value} · ${model.value}`
  : t('area.settings.serviceDescription'));
const {result: visionStatus} = useVisionProbeStatus(() => props.config, () => service.value,
    () => model.value, () => hotkeyEditorActive.value);
const capability = computed(() => visionStatus.value.capability);
const prefersVision = computed(() => props.config.areaRecognitionMode === 'prefer-vision');
const promptEditorOpen = ref(false);
let promptConfig: Config | null = null;
let promptEnabled = false;
function openVisionPromptEditor(): void {
    if (!hotkeyEditorActive.value) return;
    promptConfig = props.config;promptEnabled = props.enabled;promptEditorOpen.value = true;
}
function updateVisionPrompt(value: string): void {
    if (!promptEditorOpen.value || !hotkeyEditorActive.value || promptConfig !== props.config || promptEnabled !== props.enabled) return;
    promptConfig.areaVisionPrompt = value;
}
watch(() => [hotkeyEditorActive.value, props.config, props.enabled, promptEditorOpen.value], () => {
    if (!hotkeyEditorActive.value || promptConfig !== props.config || promptEnabled !== props.enabled || !promptEditorOpen.value) {
        promptConfig = null;promptEditorOpen.value = false;
    }
}, {flush: 'sync'});
const capabilityMessageKey = computed(() => capability.value === 'supported'
  ? 'area.settings.capabilitySupported'
  : capability.value === 'unsupported' ? 'area.settings.capabilityUnsupported' : 'area.settings.capabilityUnknown');
const supportsAI = computed(() => servicesType.isUseAIContext(
  service.value,
  resolveConfiguredModel(props.config.model[service.value], props.config.customModel[service.value]),
));
const unavailableMessage = computed(() => props.config.disabledTranslationServices.includes(service.value)
  ? t('settings.services.library.serviceDisabledMessage') : getTranslationServiceUnavailableMessage(service.value));
const savedServiceUnavailable = computed(() => props.config.areaTranslationService
  && !props.serviceOptions.some(item => item.value === props.config.areaTranslationService));

</script>

<style scoped>
.area-settings-compact :deep(.feature-enable-card) { margin-bottom: 8px; border: 0; background: transparent; }
.area-settings-compact :deep(.feature-enable-card button) { min-height: 64px; padding: 14px 20px; }
.area-settings-compact :deep(.settings-group-body) { padding: 4px 0 0; }
.area-settings-note { margin: 8px 20px 16px; color: var(--muted); font-size: 12px; line-height: 1.65; }
.area-settings-warning, .area-translation-details small.area-settings-warning { color: var(--el-color-warning); }
.area-ocr-details { width: min(100%, 1080px); margin: 0 auto 24px; }
.area-ocr-details > summary { padding: 2px 2px 14px; color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; }
.area-ocr-details > summary:hover { color: var(--ink); }
.area-prompt-description { margin: 0 0 14px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.area-prompt-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.hotkey-config { display: flex; flex-direction: column; gap: 8px; }
.area-hotkey-custom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border: 1px dashed var(--line); border-radius: 8px; }
.area-hotkey-text { color: var(--ink); font-size: 12px; overflow-wrap: anywhere; }
.area-hotkey-placeholder { color: var(--muted); }
</style>
