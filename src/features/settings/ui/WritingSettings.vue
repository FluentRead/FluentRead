<!--
 * @file src/features/settings/ui/WritingSettings.vue
 * 文件职责：提供写作助手总开关、默认回复偏好和 AI 服务连接设置，让首次使用路径清晰可见。
 * 主要内容：独立选择输出语言，复用写作卡片的直接点选标签组保存长度、风格、语气和角色，稳定编辑有界自定义描述，并配置服务连接。
 * 模块边界：只编辑设置中心持久化的同一份写作配置；不提供快捷键、重复入口开关或网站列表，不生成或改写正文。
 -->
<template>
  <div class="writing-settings">
    <p class="writing-description">在回复框旁点「写作助手」，起草回复或完善已有草稿。</p>
    <SettingsGroup>
      <FeatureEnableCard v-model="config.writing.enabled" title="启用写作助手" description="自动出现在 GitHub 和 Gmail 的回复区。点击入口开始写作，发送前由你确认。" />
      <div class="writing-sites"><span>GitHub · Issue / Pull Request</span><span>Gmail · 邮件</span></div>
    </SettingsGroup>
    <SettingsGroup>
      <SettingsItem label="输出语言" description="默认跟随网页翻译的目标语言。">
        <el-select v-model="config.writing.language" class="writing-default-language" aria-label="输出语言" filterable>
          <el-option v-for="item in WRITING_LANGUAGES" :key="item.value" :value="item.value" :label="item.value === 'target' ? `跟随目标语言 · ${targetLanguageLabel}` : item.label" />
        </el-select>
      </SettingsItem>
    </SettingsGroup>
    <SettingsGroup title="回答风格" description="设置会自动保存，并与写作卡片中的偏好同步。调整这里不会生成正文。">
      <div class="writing-default-style">
        <section><h3>长度</h3><WritingChoices v-model="config.writing.length" :options="WRITING_LENGTHS" label="长度" /></section>
        <section><h3>风格</h3><WritingChoices v-model="config.writing.style" :options="WRITING_STYLES" label="风格" /></section>
        <section><h3>语气</h3><WritingChoices v-model="toneChoice" :options="toneOptions" label="语气" />
          <div v-if="toneChoice === 'custom'" class="writing-custom-preference"><el-input :model-value="customTone" :maxlength="WRITING_TONE_MAX_LENGTH" aria-label="自定义语气" placeholder="例如：耐心、鼓励，避免夸张" @update:model-value="updateCustomTone" /><small>留空时使用自然语气。</small></div>
        </section>
        <section><h3>您的角色</h3><WritingChoices v-model="roleChoice" :options="roleOptions" label="您的角色" />
          <div v-if="roleChoice === 'custom'" class="writing-custom-preference"><el-input :model-value="customRole" :maxlength="WRITING_ROLE_MAX_LENGTH" aria-label="自定义角色" placeholder="例如：正在排查问题的项目维护者" @update:model-value="updateCustomRole" /><small>留空时不指定回复身份。</small></div>
        </section>
      </div>
    </SettingsGroup>
    <SettingsGroup title="写作服务">
      <SettingsItem label="AI 服务">
        <el-select v-model="config.writing.service" aria-label="写作服务" placeholder="选择 AI 服务" @change="config.writing.model = ''">
          <el-option v-if="defaultSupported" value="" :label="`跟随默认服务 · ${defaultServiceLabel}`" />
          <el-option v-for="item in serviceOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </SettingsItem>
      <SettingsItem label="模型">
        <el-select v-model="config.writing.model" clearable filterable allow-create default-first-option aria-label="写作模型" :placeholder="resolvedModel || '选择或输入模型'" :disabled="!supported">
          <el-option v-for="item in modelOptions" :key="item" :label="item" :value="item" />
        </el-select>
      </SettingsItem>
      <div class="writing-connection"><p>{{ supported ? '使用已保存的服务连接。写作服务可与网页翻译分别选择。' : '写作需要 AI 服务。选择服务并配置连接后，即可从网页开始。' }}</p><button type="button" @click="emit('configure-service')">配置服务连接 →</button></div>
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import {computed, ref, toRef, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {models, options, resolveConfiguredModel} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {WRITING_LANGUAGES, WRITING_LENGTHS, WRITING_STYLES, WRITING_TONES, WRITING_ROLES, WRITING_TONE_MAX_LENGTH, WRITING_ROLE_MAX_LENGTH, resolveWritingLanguage} from '@/src/core/config/writing';
import {WritingChoices} from '@/src/features/writing-assistant/public';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
const props = defineProps<{config: Config}>(); const config = toRef(props, 'config');
const emit = defineEmits<{'configure-service': []}>();
const targetLanguageLabel = computed(() => WRITING_LANGUAGES.find(item => item.value === resolveWritingLanguage('target', config.value.to))!.label);
const toneOptions = [...WRITING_TONES, {value: 'custom', label: '自定义'}];
const roleOptions = [...WRITING_ROLES, {value: 'custom', label: '自定义'}];
// 自定义选择独立于已保存值，避免空输入回落或输入恰好等于预设 ID 时让控件突然消失。
function customPreference(field: 'tone' | 'role', presets: readonly {value: string}[], limit: number, fallback: string) {
  const isPreset = (value: string) => presets.some(item => item.value === value);
  const custom = ref(!isPreset(config.value.writing[field]));
  const text = ref(custom.value ? config.value.writing[field] : '');
  let localValue: string | undefined;
  function save(value: string) {
    const normalized = value.trim() || fallback;
    if (config.value.writing[field] === normalized) return;
    localValue = normalized; config.value.writing[field] = normalized;
  }
  const choice = computed({get: () => custom.value ? 'custom' : config.value.writing[field], set: (value: string) => {
    custom.value = value === 'custom'; save(custom.value ? text.value : value);
  }});
  watch(() => config.value.writing[field], value => {
    if (value === localValue) { localValue = undefined; return; }
    custom.value = !isPreset(value); text.value = custom.value ? value : '';
  });
  function update(value: string | number) { text.value = String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, limit); save(text.value); }
  return {choice, text, update};
}
const {choice: toneChoice, text: customTone, update: updateCustomTone} = customPreference('tone', WRITING_TONES, WRITING_TONE_MAX_LENGTH, 'natural');
const {choice: roleChoice, text: customRole, update: updateCustomRole} = customPreference('role', WRITING_ROLES, WRITING_ROLE_MAX_LENGTH, 'auto');
const serviceOptions = computed(() => [...options.services.filter(item => !item.disabled && isHarnessService(item.value)), ...config.value.customOpenAIProviders.map(item => ({value: item.id, label: item.name}))]);
const service = computed(() => config.value.writing.service || config.value.service);
const supported = computed(() => isHarnessService(service.value, config.value.customOpenAIProviders));
const defaultSupported = computed(() => isHarnessService(config.value.service, config.value.customOpenAIProviders));
const defaultServiceLabel = computed(() => serviceOptions.value.find(item => item.value === config.value.service)?.label || config.value.service);
const resolvedModel = computed(() => resolveConfiguredModel(config.value.model[service.value], config.value.customModel[service.value]));
const modelOptions = computed(() => (isCustomOpenAIProviderId(service.value) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service.value) : models.get(service.value) ?? []).filter(item => item !== '自定义模型'));
</script>
<style scoped>
.writing-settings{max-width:880px;margin:0 auto}.writing-description{margin:0 0 22px;color:var(--muted);font-size:13px;line-height:1.8}.writing-sites{display:flex;gap:8px;flex-wrap:wrap;padding:0 18px 16px}.writing-sites span{padding:4px 9px;border:1px solid var(--line);border-radius:6px;font-size:11px;color:var(--muted);background:var(--surface)}.writing-default-language{max-width:280px!important}.writing-default-style{--w-brand:var(--brand);--w-brand-soft:var(--brand-soft);--w-ink:var(--ink);--w-soft:var(--surface-soft);--w-line:var(--line);display:flex;flex-direction:column;gap:16px;padding:16px 18px}.writing-default-style h3{margin:0 0 8px;font-size:12px;line-height:1.5;font-weight:600;color:var(--ink)}.writing-default-style :deep(.writing-choices){gap:7px}.writing-default-style :deep(.writing-choices button){box-sizing:border-box;min-height:32px;height:32px;padding:6px 12px;font-size:12px;line-height:18px;border-radius:8px}.writing-custom-preference{display:flex;flex-direction:column;gap:6px;width:100%;max-width:420px;min-width:0;margin-top:9px}.writing-custom-preference small{font-size:10.5px;line-height:1.55;color:var(--muted)}.writing-connection{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:0 18px 16px}.writing-connection p{margin:0;font-size:12px;line-height:1.8;color:var(--muted)}.writing-connection button{flex-shrink:0;border:0;padding:0;background:none;color:var(--brand);font:inherit;font-size:12px;cursor:pointer}.writing-connection button:focus-visible{outline:2px solid var(--brand);outline-offset:4px}@media(max-width:600px){.writing-connection{align-items:flex-start;flex-direction:column;gap:10px}.writing-default-style{padding:14px 12px;gap:15px}}@media(max-width:480px){.writing-default-language{max-width:none!important}.writing-custom-preference{max-width:none}}
</style>
