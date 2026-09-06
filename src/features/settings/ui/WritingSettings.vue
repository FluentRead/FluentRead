<!--
 * @file src/features/settings/ui/WritingSettings.vue
 * 文件职责：提供写作助手唯一总开关与 AI 服务连接设置，让首次使用路径清晰可见。
 * 主要内容：说明 GitHub 和 Gmail 自动提供入口，选择服务与模型，直接进入已有服务连接配置。
 * 模块边界：只编辑设置中心持久化的配置；不提供快捷键、重复入口开关或网站列表，不在此生成正文。
 -->
<template>
  <div class="writing-settings">
    <p class="writing-description">在回复框旁点「写作助手」，起草回复或完善已有草稿。</p>
    <SettingsGroup>
      <FeatureEnableCard v-model="config.writing.enabled" title="启用写作助手" description="自动出现在 GitHub 和 Gmail 的回复区。点击入口开始写作，发送前由你确认。" />
      <div class="writing-sites"><span>GitHub · Issue / Pull Request</span><span>Gmail · 邮件</span></div>
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
    <p class="writing-hint">语言、篇幅和语气，可在每次写作时直接调整。</p>
  </div>
</template>
<script setup lang="ts">
import {computed, toRef} from 'vue';
import type {Config} from '@/src/core/config/model';
import {models, options, resolveConfiguredModel} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
const props = defineProps<{config: Config}>(); const config = toRef(props, 'config');
const emit = defineEmits<{'configure-service': []}>();
const serviceOptions = computed(() => [...options.services.filter(item => !item.disabled && isHarnessService(item.value)), ...config.value.customOpenAIProviders.map(item => ({value: item.id, label: item.name}))]);
const service = computed(() => config.value.writing.service || config.value.service);
const supported = computed(() => isHarnessService(service.value, config.value.customOpenAIProviders));
const defaultSupported = computed(() => isHarnessService(config.value.service, config.value.customOpenAIProviders));
const defaultServiceLabel = computed(() => serviceOptions.value.find(item => item.value === config.value.service)?.label || config.value.service);
const resolvedModel = computed(() => resolveConfiguredModel(config.value.model[service.value], config.value.customModel[service.value]));
const modelOptions = computed(() => (isCustomOpenAIProviderId(service.value) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service.value) : models.get(service.value) ?? []).filter(item => item !== '自定义模型'));
</script>
<style scoped>
.writing-settings{max-width:880px;margin:0 auto}.writing-description{margin:0 0 22px;color:var(--muted);font-size:13px;line-height:1.8}.writing-sites{display:flex;gap:8px;flex-wrap:wrap;padding:0 18px 16px}.writing-sites span{padding:4px 9px;border:1px solid var(--line);border-radius:6px;font-size:11px;color:var(--muted);background:var(--surface)}.writing-connection{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:0 18px 16px}.writing-connection p{margin:0;font-size:12px;line-height:1.8;color:var(--muted)}.writing-connection button{flex-shrink:0;border:0;padding:0;background:none;color:var(--brand);font:inherit;font-size:12px;cursor:pointer}.writing-connection button:focus-visible{outline:2px solid var(--brand);outline-offset:4px}.writing-hint{margin:20px 18px;font-size:12px;color:var(--muted)}@media(max-width:600px){.writing-connection{align-items:flex-start;flex-direction:column;gap:10px}}
</style>
