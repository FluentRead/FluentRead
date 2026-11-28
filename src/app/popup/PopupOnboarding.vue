<!--
 * @file src/app/popup/PopupOnboarding.vue
 * 文件职责：作为 Popup 首启专用根组件，展示引导并在语言确认后接入完整主菜单。
 * 主要内容：复用共享配置、语言选择和主题字体；保存成功后立即预加载并切换主菜单，交接期间以轻量状态替代语言确认；已挂载页面往返缓存隐藏时使旧引导事件与迟到结果失效，配对恢复后重建当前引导上下文并续接已保存且已确认的交接；普通退出、重载和卸载保持终止，失活时释放外观订阅，加载失败可明确重开。
 * 模块边界：不读取当前标签页、不实现主菜单交互、不另存配置；主菜单仅通过动态 import 加载，持久化仍由共享 i18n/config store 负责。
-->
<template>
  <component :is="mainApp" v-if="mainApp" />
  <main v-else class="popup-shell language-onboarding-shell" data-config-ready="true" :data-interface-skin="config.interfaceSkin">
    <UiLanguageOnboarding
      v-if="!handoffRequested"
      :key="onboardingContext.revision.value"
      :initial-language="initialLanguage"
      :enable-scenario-step="true"
      :current-config="config"
      :apply-scenario-patch="applyScenarioPatch"
      :onSaved="onboardingActions.saved"
      :onConfirmed="onboardingActions.confirmed"
    />
    <p v-else-if="!loadFailed" class="onboarding-opening" role="status" data-i18n-ignore>{{ onboardingChineseMessages['common.loading'] }} / {{ onboardingEnglishMessages['common.loading'] }}</p>
    <div v-if="loadFailed" class="onboarding-load-error" role="alert" data-i18n-ignore>
      <p>{{ onboardingLoadError['zh-CN'] }}<br />{{ onboardingLoadError['en-US'] }}</p>
      <button type="button" :onClick="onboardingActions.retry">{{ onboardingChineseMessages['common.retry'] }} / {{ onboardingEnglishMessages['common.retry'] }}</button>
    </div>
  </main>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, shallowRef, watch, type Component} from 'vue';
import browser from 'webextension-polyfill';
import {config, requestConfigPatch, subscribeConfig} from '@/src/services/config/store';
import type {Config} from '@/src/core/config/model';
import {resolveUiLanguageFromLocale} from '@/src/core/i18n/language';
import {onboardingChineseMessages, onboardingEnglishMessages, onboardingLoadError} from '@/src/core/i18n/messages/onboarding';
import {applyInterfaceSkin, applyInterfaceFont, applyInterfaceTheme} from '@/src/ui/interfaceAppearance';
import UiLanguageOnboarding from '@/src/ui/components/UiLanguageOnboarding.vue';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';

const initialLanguage = resolveUiLanguageFromLocale(readLocale());
const mainApp = shallowRef<Component | null>(null);
const loadFailed = ref(false);
const handoffRequested = ref(false);
const pageExited = ref(false);
const onboardingContext = useSettingsActionContext(() => !mainApp.value && !pageExited.value, () => []);
const darkMode = matchMedia('(prefers-color-scheme: dark)');
let pendingMain: Promise<Component> | undefined;
let stopAppearance: (() => void) | undefined;
let persistedHidden = false;
let terminal = false;

function readLocale(): unknown {
  try {
    return browser.i18n.getUILanguage() || navigator.languages?.[0] || navigator.language;
  } catch {
    return navigator.languages?.[0] || navigator.language;
  }
}

function applyAppearance(): void {
  if (!onboardingContext.active.value) return;
  applyInterfaceSkin(config.interfaceSkin);
  applyInterfaceFont(config.interfaceFont);
  applyInterfaceTheme(config.theme === 'dark' || (config.theme === 'auto' && darkMode.matches));
}
watch(onboardingContext.active, active => {
  stopAppearance?.();
  stopAppearance = undefined;
  if (!active) return;
  const current = onboardingContext.capture();
  const apply = () => {if (current()) applyAppearance();};
  apply();
  const unsubscribe = subscribeConfig(apply);
  darkMode.addEventListener('change', apply);
  stopAppearance = () => {
    unsubscribe();
    darkMode.removeEventListener('change', apply);
  };
}, {immediate: true, flush: 'sync'});

async function applyScenarioPatch(patch: Partial<Config>): Promise<void> {
  if (!onboardingContext.active.value || Object.keys(patch).length === 0) return;
  Object.assign(config, patch);
  await requestConfigPatch(patch).catch(() => undefined);
}
function loadMain(): Promise<Component> {
  return pendingMain ??= import('./PopupApp.vue').then(module => module.default).catch(error => {
    pendingMain = undefined;
    throw error;
  });
}
function prepareMain(current: () => boolean): void {
  if (!current()) return;
  void loadMain().catch(() => {});
}
async function openMain(current: () => boolean): Promise<void> {
  if (!current()) return;
  loadFailed.value = false;
  try {
    const app = await loadMain();
    if (current()) mainApp.value = app;
  } catch {
    if (current()) loadFailed.value = true;
  }
}
// 只恢复当前用户已确认且已持久化的菜单交接；失活时的旧回复仍不得挂载页面。
watch(onboardingContext.active, active => {
  if (active && handoffRequested.value && config.uiLanguageSetupCompleted && !loadFailed.value) {
    void openMain(onboardingContext.capture());
  }
}, {flush: 'post'});
function reloadMain(): void {
  if (!onboardingContext.active.value || !loadFailed.value) return;
  // 浏览器会缓存失败的模块 import；重开文档才能重新加载，已保存的语言由正常入口恢复。
  terminal = true;
  persistedHidden = false;
  pageExited.value = true;
  location.reload();
}
const onboardingActions = computed(() => {
  const current = onboardingContext.capture();
  return {saved: () => prepareMain(current), confirmed: () => {if (!current()) return; handoffRequested.value = true; return openMain(current);}, retry: () => {if (current()) reloadMain();}};
});
function handlePageHide(event: PageTransitionEvent): void {
  if (terminal) return;
  persistedHidden = event.persisted;
  if (!event.persisted) terminal = true;
  pageExited.value = true;
}
function handlePageShow(event: PageTransitionEvent): void {
  if (!event.persisted || !persistedHidden || terminal) return;
  persistedHidden = false;
  pageExited.value = false;
}
window.addEventListener('pagehide', handlePageHide);
window.addEventListener('pageshow', handlePageShow);
onBeforeUnmount(() => {
  terminal = true;
  persistedHidden = false;
  stopAppearance?.();
  window.removeEventListener('pagehide', handlePageHide);
  window.removeEventListener('pageshow', handlePageShow);
});
</script>

<style scoped>
.onboarding-opening { margin: 0; padding: 20px; color: var(--muted); font-size: 12px; }
.onboarding-load-error { padding: 0 20px 16px; color: var(--muted); font-size: 12px; }
.onboarding-load-error p { margin: 0 0 8px; }
.onboarding-load-error button { padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); cursor: pointer; }
</style>
