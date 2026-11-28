<!--
 * @file src/ui/components/UiLanguageOnboarding.vue
 * 文件职责：在 Popup 首次打开时，按可见高度紧凑呈现界面语言选择确认，并在启用场景引导时提供可跳过的第二步阅读场景预设。
 * 主要内容：直接展示八语原生名称与轻量中英文标题；单一 Tab 单选组支持方向键和 Home/End，并只在所属列表或极矮 Popup 内显露焦点；冻结持久化提交并隔离旧事件、排队焦点与退出后的回复，失败就地重试，语言保存成功后预加载主菜单，开启场景步骤时允许用户多选阅读场景并预览将启用的能力，可一键应用或跳过直接进入主菜单。
 * 模块边界：组件不读取持久化存储、不决定浏览器 locale 映射、不加载完整词库；语言保存由共享 i18n 负责，场景补丁写入与主菜单交接由 Popup 根组件负责。
-->
<template>
  <section ref="onboardingRoot" class="language-onboarding" data-testid="ui-language-onboarding" data-i18n-ignore
    role="dialog" aria-modal="true" :aria-labelledby="step === 'language' ? 'language-onboarding-title' : 'scenario-onboarding-title'" :aria-busy="confirming || committed">
    <div v-if="step === 'language'" class="language-onboarding-card onboarding-form" data-testid="onboarding-language-step">
      <div class="onboarding-brand"><img src="/icon/128.png" alt="" /><strong>{{ onboardingProductNames[selectedLanguage] }}</strong></div>
      <h1 id="language-onboarding-title">{{ messageZh('language.onboardingTitle') }}<small>{{ messageEn('language.onboardingTitle') }}</small></h1>
      <div class="onboarding-language-options" role="radiogroup" :aria-label="bilingualMessage('language.onboardingLabel')">
        <button v-for="option in languageOptions" :key="option.value" ref="languageOptionButtons"
          class="onboarding-language-option" :class="{ selected: selectedLanguage === option.value }" type="button" role="radio"
          :aria-checked="selectedLanguage === option.value" :tabindex="interactionContext.active.value && selectedLanguage === option.value ? 0 : -1"
          :data-language="option.value" :lang="option.value" :disabled="!interactionContext.active.value" :onClick="option.choose" :onKeydown="option.keydown">
          <span>{{ nativeLanguageNames[option.value] }}</span><span class="onboarding-language-check" aria-hidden="true">✓</span>
        </button>
      </div>
      <button class="onboarding-confirm" type="button" :disabled="!interactionContext.active.value" :onClick="onboardingActions.confirm">
        <strong>{{ confirming || committed ? messageZh('common.loading') : messageZh('language.onboardingConfirm') }}</strong>
        <small>{{ confirming || committed ? messageEn('common.loading') : messageEn('language.onboardingConfirm') }}</small>
      </button>
      <p v-if="errorMessage" class="onboarding-error" role="alert" :lang="selectedLanguage">{{ errorMessage }}</p>
    </div>
    <div v-else class="language-onboarding-card onboarding-scenario-form" data-testid="onboarding-scenario-step" :lang="selectedLanguage">
      <div class="onboarding-brand"><img src="/icon/128.png" alt="" /><strong>{{ onboardingProductNames[selectedLanguage] }}</strong></div>
      <h1 id="scenario-onboarding-title">{{ t('scenarioPresets.onboarding.title') }}<small>{{ t('scenarioPresets.onboarding.subtitle') }}</small></h1>
      <div class="onboarding-scenario-options" role="group" :aria-label="t('scenarioPresets.onboarding.title')">
        <button v-for="preset in SCENARIO_PRESETS" :key="preset.id" type="button"
          class="onboarding-scenario-option" :class="{ selected: selectedScenarios.includes(preset.id) }"
          :aria-pressed="selectedScenarios.includes(preset.id)" :data-scenario="preset.id"
          :disabled="!scenarioInteractionActive" :onClick="() => toggleScenario(preset.id)">
          <span class="onboarding-scenario-head">
            <strong>{{ t(preset.titleKey) }}</strong>
            <span class="onboarding-language-check" aria-hidden="true">✓</span>
          </span>
          <small>{{ t(preset.descriptionKey) }}</small>
        </button>
      </div>
      <div class="onboarding-scenario-actions">
        <button class="onboarding-confirm" type="button" data-testid="onboarding-scenario-apply"
          :disabled="!scenarioInteractionActive || selectedScenarios.length === 0" :onClick="() => finishScenario(true)">
          <strong>{{ t('scenarioPresets.onboarding.applyAndStart') }}</strong>
        </button>
        <button class="onboarding-skip" type="button" data-testid="onboarding-scenario-skip"
          :disabled="!scenarioInteractionActive" :onClick="() => finishScenario(false)">
          {{ t('scenarioPresets.onboarding.skipAndStart') }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {
  UI_LANGUAGE_OPTIONS,
  type UiLanguage,
} from '@/src/core/i18n';
import type {Config} from '@/src/core/config/model';
import {
  buildScenarioPresetPatch,
  SCENARIO_PRESETS,
  type ScenarioPresetCurrentConfig,
  type ScenarioPresetId,
} from '@/src/core/config/scenarioPresets';
import {useUiI18n} from '@/src/ui/i18n';
import {onboardingChineseMessages, onboardingEnglishMessages, onboardingProductNames, type OnboardingMessageKey} from '@/src/core/i18n/messages/onboarding';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';

const props = withDefaults(defineProps<{
  initialLanguage: UiLanguage;
  enableScenarioStep?: boolean;
  currentConfig?: ScenarioPresetCurrentConfig;
  applyScenarioPatch?: (patch: Partial<Config>) => Promise<void> | void;
}>(), {enableScenarioStep: false});

const emit = defineEmits<{
  saved: [language: UiLanguage];
  confirmed: [language: UiLanguage];
}>();

const {language, setLanguage, t} = useUiI18n();
const nativeLanguageNames: Readonly<Record<UiLanguage, string>> = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'en-US': 'English', 'ja-JP': '日本語',
  'ko-KR': '한국어', 'fr-FR': 'Français', 'ru-RU': 'Русский', 'es-ES': 'Español',
};
// 首启保存失败不能指向尚不可用的设置页；静态反馈不等待完整语言资源，也不展示存储异常正文。
const saveFailureMessages: Readonly<Record<UiLanguage, string>> = {
  'zh-CN': '无法确认语言已保存，请再次确认重试。',
  'zh-TW': '無法確認語言已儲存，請再次確認重試。',
  'en-US': 'Could not confirm the language was saved. Confirm again to retry.',
  'ja-JP': '言語が保存されたことを確認できませんでした。もう一度確認して再試行してください。',
  'ko-KR': '언어가 저장되었는지 확인할 수 없습니다. 다시 확인하여 재시도하세요.',
  'fr-FR': 'Impossible de confirmer l’enregistrement de la langue. Confirmez à nouveau pour réessayer.',
  'ru-RU': 'Не удалось подтвердить сохранение языка. Подтвердите ещё раз, чтобы повторить попытку.',
  'es-ES': 'No se pudo confirmar que se guardara el idioma. Confirma de nuevo para reintentarlo.',
};
const selectedLanguage = ref<UiLanguage>(props.initialLanguage);
const step = ref<'language' | 'scenario'>('language');
const selectedScenarios = ref<ScenarioPresetId[]>([]);
const onboardingRoot = ref<HTMLElement | null>(null);
const languageOptionButtons = ref<HTMLButtonElement[]>([]);
const confirming = ref(false);
const committed = ref(false);
const errorMessage = ref('');
const pageExited = ref(false);
const context = useSettingsActionContext(() => !pageExited.value, () => [props.initialLanguage]);
const interactionContext = useSettingsActionContext(() => context.active.value && !confirming.value && !committed.value && step.value === 'language',
  () => [context.revision.value, selectedLanguage.value]);
const scenarioInteractionActive = computed(() => context.active.value && !confirming.value && !committed.value && step.value === 'scenario');
let pendingInitialLanguage: UiLanguage | undefined;
let focusSequence = 0;

watch(() => props.initialLanguage, value => {
  if (confirming.value) pendingInitialLanguage = value;
  else selectedLanguage.value = value;
}, {flush: 'sync'});

watch(() => [selectedLanguage.value, context.active.value] as const, ([value, active]) => {
  if (active) document.documentElement.lang = value;
}, {immediate: true});
watch(context.revision, () => {
  errorMessage.value = '';
  step.value = 'language';
  selectedScenarios.value = [];
  focusSequence += 1;
}, {flush: 'sync'});
const languageOptions = computed(() => {
  const current = interactionContext.capture();
  const choose = (value: UiLanguage) => {
    if (!current()) return;
    selectedLanguage.value = value;
    errorMessage.value = '';
  };
  return UI_LANGUAGE_OPTIONS.map((option, index) => ({...option,
    choose: () => choose(option.value),
    keydown: (event: KeyboardEvent) => {
      if (!current()
        || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? UI_LANGUAGE_OPTIONS.length - 1
        : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + UI_LANGUAGE_OPTIONS.length) % UI_LANGUAGE_OPTIONS.length;
      choose(UI_LANGUAGE_OPTIONS[nextIndex].value);
      focusSelectedLanguage();
    },
  }));
});
const onboardingActions = computed(() => {
  const current = interactionContext.capture();
  return {
    confirm: () => {if (current()) return confirm();},
  };
});

function messageZh(key: OnboardingMessageKey): string {
  return onboardingChineseMessages[key];
}

function messageEn(key: OnboardingMessageKey): string {
  return onboardingEnglishMessages[key];
}

function bilingualMessage(key: OnboardingMessageKey): string {
  return [messageZh(key), messageEn(key)].join(' / ');
}

function focusSelectedLanguage(): void {
  if (!interactionContext.active.value) return;
  const current = interactionContext.capture(), before = document.activeElement, sequence = ++focusSequence;
  if (before !== document.body && !onboardingRoot.value?.contains(before)) return;
  void nextTick(() => {
    if (!current() || sequence !== focusSequence
      || (document.activeElement !== before && document.activeElement !== document.body)) return;
    const target = languageOptionButtons.value.find(button => button.dataset.language === selectedLanguage.value);
    if (!target?.isConnected) return;
    if (target !== document.activeElement) target.focus({preventScroll: true});
    // 优先滚动语言列表；极矮布局改由所属 Popup 滚动，始终不滚动宿主页面。
    const options = target.parentElement;
    const shell = onboardingRoot.value?.closest<HTMLElement>('.popup-shell');
    const scrollOwner = options?.clientHeight && options.scrollHeight > options.clientHeight ? options : shell;
    if (!scrollOwner?.clientHeight || scrollOwner.scrollHeight <= scrollOwner.clientHeight) return;
    const visibleTop = scrollOwner.getBoundingClientRect().top + scrollOwner.clientTop;
    const visibleBottom = visibleTop + scrollOwner.clientHeight;
    const frame = target.getBoundingClientRect();
    const delta = frame.top < visibleTop ? frame.top - visibleTop : Math.max(0, frame.bottom - visibleBottom);
    scrollOwner.scrollTop += delta;
  });
}

function toggleScenario(id: ScenarioPresetId): void {
  if (!scenarioInteractionActive.value) return;
  selectedScenarios.value = selectedScenarios.value.includes(id)
    ? selectedScenarios.value.filter(item => item !== id)
    : [...selectedScenarios.value, id];
}

async function finishScenario(apply: boolean): Promise<void> {
  if (!scenarioInteractionActive.value) return;
  const current = context.capture(), chosenLanguage = selectedLanguage.value;
  confirming.value = true;
  try {
    if (apply && props.currentConfig && props.applyScenarioPatch) {
      const {patch, changedKeys} = buildScenarioPresetPatch(selectedScenarios.value, props.currentConfig);
      if (changedKeys.length > 0) await props.applyScenarioPatch(patch);
    }
    if (!current()) return;
    committed.value = true;
    emit('confirmed', chosenLanguage);
  } finally {
    confirming.value = false;
  }
}

// 唯一入口 onboardingActions.confirm 已同步验证当前交互归属，中间没有异步或外部调用。
async function confirm(): Promise<void> {
  const current = context.capture(), submittedLanguage = selectedLanguage.value;
  confirming.value = true;
  errorMessage.value = '';
  try {
    const applied = await setLanguage(submittedLanguage);
    if (applied === false || !current()) return;
    emit('saved', submittedLanguage);
    // saved 可同步关闭、替换或卸载引导；交接主菜单前再次验证归属，且不设置固定等待。
    if (!current()) return;
    if (props.enableScenarioStep) {
      step.value = 'scenario';
      return;
    }
    committed.value = true;
    emit('confirmed', submittedLanguage);
  } catch {
    if (current()) {
      document.documentElement.lang = language.value;
      errorMessage.value = saveFailureMessages[submittedLanguage];
    }
  } finally {
    // 已发出的持久化允许完成；失活后重开也继续锁定，直到这次保存真正结束。
    confirming.value = false;
    if (pendingInitialLanguage !== undefined) {
      selectedLanguage.value = pendingInitialLanguage;
      pendingInitialLanguage = undefined;
    }
  }
}

function handlePageHide(): void {pageExited.value = true;}
window.addEventListener('pagehide', handlePageHide);
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', handlePageHide);
});

watch(context.active, active => {if (active) focusSelectedLanguage();}, {immediate: true, flush: 'post'});
</script>

<style scoped>
.language-onboarding {
  position: relative;
  z-index: 20;
  background: var(--surface);
  max-height: var(--fluentread-onboarding-height, none);
  min-height: 0;
}
.language-onboarding-card { display: var(--fluentread-onboarding-layout, block); flex-direction: column; min-height: 0; max-height: inherit; padding: 16px; }
.onboarding-form > :not(.onboarding-language-options),
.onboarding-scenario-form > :not(.onboarding-scenario-options) { flex-shrink: 0; }
.onboarding-brand { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; color: var(--ink); font-size: 15px; }
.onboarding-brand img { width: 28px; height: 28px; }
h1 { margin: 0 0 14px; color: var(--ink); font-size: 17px; line-height: 1.4; }
h1 small { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; font-weight: 400; }
.onboarding-language-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; flex: 0 1 auto; min-height: var(--fluentread-onboarding-list-min, 0); align-content: start; overflow-y: var(--fluentread-onboarding-list-overflow, visible); overscroll-behavior: contain; }
.onboarding-language-option { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; min-height: 40px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-soft); color: var(--ink); font-size: 13px; cursor: pointer; }
.onboarding-language-option.selected,
.onboarding-scenario-option.selected { border-color: var(--brand); background: var(--brand-soft); }
.onboarding-language-check { color: var(--brand); visibility: hidden; }
.selected .onboarding-language-check { visibility: visible; }
.onboarding-scenario-options { display: flex; flex-direction: column; gap: 7px; flex: 0 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.onboarding-scenario-option { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-soft); color: var(--ink); text-align: left; cursor: pointer; }
.onboarding-scenario-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.onboarding-scenario-option small { font-size: 11px; line-height: 1.4; color: var(--muted); }
.onboarding-scenario-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.onboarding-confirm { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px; width: 100%; min-height: 40px; margin-top: 14px; padding: 9px 12px; border: 0; border-radius: 9px; background: var(--brand); color: #fff; cursor: pointer; }
.onboarding-scenario-actions .onboarding-confirm { margin-top: 0; }
.onboarding-confirm strong { font-size: 14px; }
.onboarding-confirm small { font-size: 12px; }
.onboarding-skip { width: 100%; min-height: 34px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 9px; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; }
button:disabled { cursor: default; opacity: .65; }
button:focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }
.onboarding-error { margin: 10px 0 0; color: var(--ink); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
</style>
