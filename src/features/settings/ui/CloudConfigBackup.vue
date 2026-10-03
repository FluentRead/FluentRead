<!--
@file src/features/settings/ui/CloudConfigBackup.vue
文件职责：将 Google Drive、Dropbox 与 WebDAV 归入同一个配置云备份入口。
主要内容：统一备份范围说明，提供有主次的存储方式选择，记住本机选择并锁定操作中的切换。
模块边界：只拥有 UI 选择状态；供应商连接和云备份事务交给各自客户端及共用预览界面。
-->
<template>
  <section class="cloud-backup" aria-labelledby="cloud-backup-title" data-testid="cloud-config-backup">
    <header><h2 id="cloud-backup-title">{{ t('settings.cloud.title') }}</h2><el-tooltip effect="light" placement="bottom-end" :show-after="150" :trigger="['hover', 'focus']"><template #content><div class="cloud-privacy-help"><strong>{{ t('settings.drive.privacyTitle') }}</strong><ul><li>{{ t('settings.cloud.privacyEncryption') }}</li><li>{{ t(selected === 'dropbox' ? 'settings.dropbox.privacyStorage' : selected === 'google-drive' ? 'settings.drive.privacyStorage' : 'settings.cloud.privacyWebDavStorage') }}</li><li>{{ t(selected !== 'webdav' ? 'settings.drive.privacyAuthorization' : 'settings.cloud.privacyWebDavConnection') }}</li><li>{{ t('settings.drive.privacyExcluded') }}</li></ul></div></template><button type="button" class="cloud-privacy" :aria-label="t('settings.drive.privacyTitle')" data-testid="cloud-backup-privacy"><el-icon><Lock /></el-icon>{{ t('settings.drive.privacyBadge') }}</button></el-tooltip></header>
    <p class="cloud-description">{{ t('settings.cloud.description') }}</p>
    <div v-if="hasExtensionBackground" class="cloud-methods" role="radiogroup" :aria-label="t('settings.cloud.method')">
      <label v-for="item in methods" :key="item.id" :class="{'is-selected': selected === item.id, 'is-disabled': busy}">
        <input v-model="selected" type="radio" name="cloud-backup-method" :value="item.id" :disabled="busy" :data-testid="`cloud-method-${item.id}`" />{{ item.name }}
      </label>
    </div>
    <el-alert v-if="!hasExtensionBackground" :title="t('settings.cloud.unavailable')" type="info" :closable="false" show-icon />
    <GoogleDriveSync v-else-if="selected === 'google-drive'" @busy="busy = $event" />
    <DropboxSync v-else-if="selected === 'dropbox'" @busy="busy = $event" />
    <WebDavBackup v-else @busy="busy = $event" />
  </section>
</template>
<script setup lang="ts">
import {ref, watch} from 'vue';
import {ElAlert, ElTooltip} from 'element-plus';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/tooltip/style/css';
import {Lock} from '@element-plus/icons-vue';
import {useUiI18n} from '@/src/ui/i18n';
import GoogleDriveSync from './GoogleDriveSync.vue';
import WebDavBackup from './WebDavBackup.vue';
import DropboxSync from './DropboxSync.vue';
const {t} = useUiI18n();
const hasExtensionBackground = import.meta.env.BROWSER !== 'userscript';
const methods = [{id: 'google-drive', name: 'Google Drive'}, {id: 'dropbox', name: 'Dropbox'}, {id: 'webdav', name: 'WebDAV'}] as const;
const selected = ref<'google-drive' | 'dropbox' | 'webdav'>('google-drive');
const busy = ref(false);
try {const method = localStorage.getItem('fluentread-cloud-backup-method'); if (method === 'webdav' || method === 'dropbox') selected.value = method;} catch { /* 存储受限时仍可使用默认选择。 */ }
watch(selected, value => {try {localStorage.setItem('fluentread-cloud-backup-method', value);} catch { /* 选择仍对本次页面有效。 */ }});
</script>
<style scoped>
.cloud-backup {padding:24px; margin-bottom:24px; border:1px solid var(--el-border-color); border-radius:16px; background:var(--el-bg-color); color:var(--el-text-color-primary);}
.cloud-backup>header {display:flex; align-items:center; justify-content:space-between; gap:12px;}
.cloud-backup h2 {font-size:19px; margin:0;}
.cloud-description {font-size:13px; line-height:1.7; color:var(--el-text-color-secondary); margin:12px 0 20px;}
.cloud-privacy {display:inline-flex; align-items:center; gap:5px; font:inherit; font-size:12px; color:var(--el-text-color-secondary); white-space:nowrap; border:0; border-radius:20px; padding:4px 10px; background:var(--el-fill-color-light); cursor:help;}
.cloud-privacy:hover,.cloud-privacy:focus {color:var(--el-color-success); background:var(--el-color-success-light-9);}
.cloud-privacy:focus-visible {outline:2px solid var(--el-color-success); outline-offset:3px;}
.cloud-privacy-help {width:min(300px, calc(100vw - 64px)); font-size:13px; line-height:1.7; color:var(--el-text-color-regular);}
.cloud-privacy-help strong {color:var(--el-text-color-primary);}
.cloud-privacy-help ul {margin:8px 0 0; padding-left:18px;}
.cloud-privacy-help li+li {margin-top:6px;}
.cloud-methods {display:flex; flex-wrap:wrap; gap:8px; padding-bottom:20px; border-bottom:1px solid var(--el-border-color-lighter); margin-bottom:20px;}
.cloud-methods label {display:flex; align-items:center; gap:8px; padding:9px 14px; border:1px solid var(--el-border-color); border-radius:8px; font-size:13px; cursor:pointer;}
.cloud-methods label.is-selected {border-color:var(--el-color-primary); background:var(--el-color-primary-light-9);}
.cloud-methods label:focus-within {outline:2px solid var(--el-color-primary); outline-offset:2px;}
.cloud-methods input {accent-color:var(--el-color-primary); margin:0;}
.cloud-methods .is-disabled {opacity:.65; cursor:wait;}
@media(max-width:600px) {.cloud-backup {padding:16px;}}
</style>
