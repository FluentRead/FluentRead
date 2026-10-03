<!--
@file src/features/settings/ui/DropboxSync.vue
文件职责：将 Dropbox 接入共用配置云备份界面。
主要内容：注入独立同步客户端与供应商名称，提供接入指南，并向存储方式选择器传递忙碌状态，防止未完成事务时切走。
模块边界：不获取令牌或完整配置；授权与事务由后台负责。
-->
<template>
  <RemoteConfigSync :client="dropboxSyncClient" provider="Dropbox" kind="dropbox" @busy="$emit('busy', $event)">
    <template #connection><p class="dropbox-guide"><a href="https://read.thinkstu.com/config/dropbox-sync" target="_blank" rel="noopener noreferrer">{{ t('settings.dropbox.setupGuide') }}</a></p></template>
  </RemoteConfigSync>
</template>
<script setup lang="ts">
import RemoteConfigSync from './RemoteConfigSync.vue';
import {dropboxSyncClient} from '@/src/services/config/dropboxSyncClient';
import {useUiI18n} from '@/src/ui/i18n';
defineEmits<{busy: [value: boolean]}>();
const {t} = useUiI18n();
</script>
<style scoped>
.dropbox-guide {margin:0 0 12px; font-size:13px;}
.dropbox-guide a {color:var(--el-color-primary);}
</style>
