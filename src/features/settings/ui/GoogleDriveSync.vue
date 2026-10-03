<!--
@file src/features/settings/ui/GoogleDriveSync.vue
文件职责：保留既有 Google Drive 配置同步入口并注入原生 Chrome 同步客户端。
主要内容：将 Google 云盘标识和独立消息端口传入共用确认界面，继续复用已有单次授权、上次账号与两步确认的体验。
模块边界：只负责 Google 产品入口的装配；不访问完整配置、授权令牌或隐藏云端文件，事务仍由后台服务执行。
-->
<template><CloudConfigSync provider="google-drive" :client="googleDriveSyncClient" /></template>
<script setup lang="ts">
import CloudConfigSync from './CloudConfigSync.vue';
import {googleDriveSyncClient} from '@/src/services/config/googleDriveSyncClient';
</script>
