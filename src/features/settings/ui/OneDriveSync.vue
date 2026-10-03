<!--
@file src/features/settings/ui/OneDriveSync.vue
文件职责：为设置页提供微软 OneDrive 应用文件夹配置同步入口。
主要内容：向复用界面传入 OneDrive 品牌和独立消息客户端，让账号记录、授权错误和确认操作使用微软对应文案。
模块边界：不自行调用 Microsoft Graph、读取配置或持有短期令牌，实际可用性由后台身份能力与公开客户端配置决定。
-->
<template><CloudConfigSync provider="onedrive" :client="oneDriveSyncClient" /></template>
<script setup lang="ts">
import CloudConfigSync from './CloudConfigSync.vue';
import {oneDriveSyncClient} from '@/src/services/config/googleDriveSyncClient';
</script>
