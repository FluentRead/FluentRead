<!--
@file src/features/settings/ui/GoogleDriveSync.vue
文件职责：把 Google Drive 作为配置云备份的一种存储方式接入共用界面。
主要内容：提供已有后台客户端、供应商名称和动作标记；保留单次授权与更换账号入口。
模块边界：不读取配置或令牌；预览和确认交互由 RemoteConfigSync 统一实现。
-->
<template><RemoteConfigSync :client="googleDriveSyncClient" provider="Google Drive" kind="google-drive" @busy="$emit('busy', $event)" /></template>
<script setup lang="ts">
import RemoteConfigSync from './RemoteConfigSync.vue';
import {googleDriveSyncClient} from '@/src/services/config/googleDriveSyncClient';
defineEmits<{busy: [value: boolean]}>();
</script>
