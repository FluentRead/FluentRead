<!--
 @file src/app/sidepanel/SidepanelApp.vue
 文件职责：在原生侧边栏内提供文本翻译入口、共享工作台与设置导航。
 主要内容：按权威配置同步亮暗主题、界面皮肤和字体，顶部按钮打开设置中的翻译中心，并提供缺少凭据时的定向配置入口；面板内输入与结果由共享翻译中心维护，切换网页不重建会话。
 模块边界：这里只编排公共组件、浏览器导航和页面外观，翻译调用、停止与复制由 translation-center feature 负责；关闭页面由组合根卸载并取消请求。
-->
<template>
  <main class="sidepanel-shell">
    <header class="sidepanel-header">
      <h1>{{ translateLegacy('翻译中心') }}</h1>
      <button type="button" :aria-label="t('sidepanel.openCenter')" :title="t('sidepanel.openCenter')" @click="openSettings('settings-translation-center')"><UiIcon name="sliders" /></button>
    </header>
    <p v-if="navigationError" class="sidepanel-error" role="alert">{{ t('sidepanel.settingsError') }}</p>
    <TranslationCenter surface="sidebar" @configure-service="service => openSettings('settings-services', service)" @configure-general="openSettings('settings-general')" />
  </main>
</template>
<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref} from 'vue';
import browser from 'webextension-polyfill';
import {TranslationCenter} from '@/src/features/translation-center/public';
import UiIcon from '@/src/ui/components/UiIcon.vue';
import {useUiI18n} from '@/src/ui/i18n';
import {config, subscribeConfig} from '@/src/services/config/store';
import {applyInterfaceFont, applyInterfaceSkin, registerInterfaceAppearanceRoot} from '@/src/ui/interfaceAppearance';

const {t, translateLegacy} = useUiI18n();
const navigationError = ref(false);
const darkMode = window.matchMedia('(prefers-color-scheme: dark)');
let disposed = false;
let unsubscribe: (() => void) | undefined;
let releaseAppearance: (() => void) | undefined;
function applyAppearance() {
  applyInterfaceSkin(config.interfaceSkin);applyInterfaceFont(config.interfaceFont);
  document.documentElement.classList.toggle('dark', config.theme === 'dark' || (config.theme === 'auto' && darkMode.matches));
}
async function openSettings(section: string, service?: string) {
  if (disposed) return;
  navigationError.value = false;
  try {
    const query = service ? `?${new URLSearchParams({service})}` : '';
    await browser.tabs.create({url: `${browser.runtime.getURL('options.html')}${query}#${section}`});
  } catch {if (!disposed) navigationError.value = true;}
}
onMounted(() => {
  releaseAppearance = registerInterfaceAppearanceRoot(document.documentElement);
  applyAppearance();unsubscribe = subscribeConfig(applyAppearance);
  darkMode.addEventListener('change', applyAppearance);
});
onBeforeUnmount(() => {
  disposed = true;unsubscribe?.();releaseAppearance?.();
  darkMode.removeEventListener('change', applyAppearance);
});
</script>
