<!--
 * @file src/features/settings/ui/VideoSemanticSegmentationSettings.vue
 * 文件职责：集中扩展专属 AI 断句开关、显式服务与模型配置，保留设置定位锚点。
 * 主要内容：使用共享设置行及服务能力判断，直接更新传入配置，不请求模型。
 * 模块边界：由设置页按扩展能力挂载；userscript 在构建边界替换此组件，避免携带不可用的表单与筛选逻辑。
 -->
<template>
        <SettingsItem id="video-semantic-segmentation" data-settings-anchor="video-semantic-segmentation" :data-settings-anchor-label="t('video.learning.segmentationTitle')" :label="t('video.learning.segmentationTitle')" :description="t('video.learning.segmentationDescription')">
          <el-switch v-model="config.videoSemanticSegmentationEnabled" :aria-label="t('video.learning.segmentationTitle')" />
        </SettingsItem>
        <SettingsItem v-if="config.videoSemanticSegmentationEnabled" :label="t('video.learning.segmentationService')" :description="t('video.learning.segmentationServiceDescription')">
          <el-select v-model="config.videoSemanticSegmentationService" :aria-label="t('video.learning.segmentationService')" :placeholder="t('video.learning.segmentationServicePlaceholder')" filterable>
            <el-option v-for="item in semanticServiceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </SettingsItem>
        <SettingsItem v-if="config.videoSemanticSegmentationEnabled" :label="t('video.learning.segmentationModel')" :description="t('video.learning.segmentationModelDescription')">
          <el-input v-model="config.videoSemanticSegmentationModel" :aria-label="t('video.learning.segmentationModel')" maxlength="200" :placeholder="t('video.learning.segmentationModelPlaceholder')" />
        </SettingsItem>
</template>
<script setup lang="ts">
import {computed} from 'vue';
import type {Config} from '@/src/core/config/model';
import {isHarnessService} from '@/src/core/config/harness';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsItem from './components/SettingsItem.vue';
const props = defineProps<{config: Config; services: readonly {value: string; label: string; disabled?: boolean}[]}>();
const {t} = useUiI18n();
const semanticServiceOptions = computed(() => props.services.filter(item => !item.disabled && isHarnessService(item.value, props.config.customOpenAIProviders)));
</script>
