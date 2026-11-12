<!--
 * @file src/ui/components/UiLanguageOnboarding.vue
 * 文件职责：承载 FluentRead Popup 首次打开时的欢迎与界面语言选择引导。
 * 主要内容：直接使用轻量中英文资源展示稳定尺寸的欢迎画面和完整语言名称，品牌随当前预览语言呈现；语言卡片以单一 Tab 入口、四方向键和 Home/End 循环切换预览，沿用当前步骤的焦点归属保护；冻结每次提交的语言，限定旧事件、焦点和成功计时器的活跃归属，确认保存后通知上层准备主菜单，成功动效结束后交回控制权；保留首启铺满弹窗的方形问候画板与三步同高布局。
 * 模块边界：组件只负责首次引导的呈现与确认，不读取配置、不决定浏览器 locale 映射；配置保存由 src/ui/i18n.ts 负责，语言规则由 src/core/i18n 提供。
-->
<template>
  <section
    ref="onboardingRoot"
    class="language-onboarding"
    data-testid="ui-language-onboarding"
    data-i18n-ignore
    role="dialog"
    aria-modal="true"
    aria-labelledby="language-onboarding-title"
  >
    <div class="language-onboarding-backdrop" aria-hidden="true" />
    <div class="language-onboarding-card">
      <Transition name="onboarding-content" mode="out-in" :onAfterEnter="onboardingActions.focus">
        <div v-if="celebrating" key="success" class="onboarding-success">
          <div class="onboarding-success-mark" aria-hidden="true"><span>✓</span></div>
          <h1 id="language-onboarding-title">
            {{ messageZh('language.onboardingSuccessEyebrow') }}
            <small class="onboarding-title-secondary">{{ messageEn('language.onboardingSuccessEyebrow') }}</small>
          </h1>
        </div>

        <div v-else-if="step === 'welcome'" key="welcome" class="onboarding-welcome" data-testid="onboarding-welcome">
          <div class="onboarding-brand">
            <img class="brand-icon" src="/icon/128.png" alt="" />
            <strong>{{ onboardingProductNames[selectedLanguage] }}</strong>
          </div>

          <div class="welcome-art" aria-hidden="true">
            <span
              v-for="greeting in WELCOME_GREETING_WORDS"
              :key="greeting"
              class="welcome-word"
            >{{ greeting }}</span>
          </div>

          <div class="onboarding-copy welcome-copy">
            <h1 id="language-onboarding-title">
              {{ messageZh('language.onboardingWelcomeEyebrow') }}
              <small class="onboarding-title-secondary">{{ messageEn('language.onboardingWelcomeEyebrow') }}</small>
            </h1>
          </div>

          <button
            ref="welcomeNextButton"
            class="onboarding-confirm onboarding-next"
            data-testid="onboarding-language-next"
            type="button"
            :disabled="!interactionContext.active.value"
            :onClick="onboardingActions.next"
          >
            <span class="onboarding-button-copy">
              <strong>{{ messageZh('language.onboardingWelcomeNext') }}</strong>
              <small>{{ messageEn('language.onboardingWelcomeNext') }}</small>
            </span>
            <svg class="onboarding-next-arrow" aria-hidden="true" viewBox="0 0 16 12" focusable="false">
              <path d="M1 6h13M9 1l5 5-5 5" />
            </svg>
          </button>
        </div>

        <div v-else key="setup" class="onboarding-form" data-testid="onboarding-language-step">
          <button class="onboarding-back" type="button" :disabled="!interactionContext.active.value" :onClick="onboardingActions.back">
            <svg class="onboarding-back-arrow" aria-hidden="true" viewBox="0 0 16 12" focusable="false">
              <path d="M15 6H1M7 1L1 6l6 5" />
            </svg>
            <span>{{ bilingualMessage('language.onboardingBack') }}</span>
          </button>

          <div class="onboarding-copy">
            <h1 id="language-onboarding-title">
              {{ messageZh('language.onboardingTitle') }}
              <small class="onboarding-title-secondary">{{ messageEn('language.onboardingTitle') }}</small>
            </h1>
          </div>

          <div class="onboarding-language-field">
            <div
              class="onboarding-language-options"
              role="radiogroup"
              :aria-label="bilingualMessage('language.onboardingLabel')"
            >
              <button
                v-for="option in languageOptions"
                :key="option.value"
                ref="languageOptionButtons"
                class="onboarding-language-option"
                :class="{ selected: selectedLanguage === option.value }"
                type="button"
                role="radio"
                :aria-checked="selectedLanguage === option.value"
                :tabindex="interactionContext.active.value && selectedLanguage === option.value ? 0 : -1"
                :data-language="option.value"
                :disabled="!interactionContext.active.value"
                :onClick="option.choose"
                :onKeydown="option.keydown"
              >
                <span class="onboarding-language-name">
                  <span
                    v-for="(label, index) in getUiLanguageBilingualLabel(option.value).split(' / ')"
                    :key="index"
                    :lang="index === 0 ? 'zh-CN' : 'en'"
                    :class="{ 'onboarding-language-secondary': index > 0 }"
                  >{{ label }}</span>
                </span>
                <span class="onboarding-language-check" aria-hidden="true">✓</span>
              </button>
            </div>
          </div>

          <div class="onboarding-confirm-guide" aria-hidden="true">
            <svg class="onboarding-guide-arrow" viewBox="0 0 16 22" focusable="false">
              <path d="M8 1v15M3 12l5 5 5-5" />
            </svg>
          </div>

          <button
            class="onboarding-confirm"
            type="button"
            :disabled="!interactionContext.active.value"
            :onClick="onboardingActions.confirm"
          >
            <span class="onboarding-button-copy">
              <strong>{{ confirming ? messageZh('common.loading') : messageZh('language.onboardingConfirm') }}</strong>
              <small>{{ confirming ? messageEn('common.loading') : messageEn('language.onboardingConfirm') }}</small>
            </span>
          </button>

          <p v-if="errorMessage" class="onboarding-error" role="alert">{{ errorMessage }}</p>
        </div>
      </Transition>
    </div>
  </section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {
  getUiLanguageBilingualLabel,
  UI_LANGUAGE_OPTIONS,
  type UiLanguage,
} from '@/src/core/i18n';
import {useUiI18n} from '@/src/ui/i18n';
import {onboardingChineseMessages, onboardingEnglishMessages, onboardingProductNames, type OnboardingMessageKey} from '@/src/core/i18n/messages/onboarding';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';

const props = defineProps<{
  initialLanguage: UiLanguage;
}>();

const emit = defineEmits<{
  saved: [language: UiLanguage];
  confirmed: [language: UiLanguage];
}>();

const {language, setLanguage} = useUiI18n();
const WELCOME_GREETING_WORDS = [
  '你好',
  'Hello',
  'こんにちは',
  '안녕하세요',
  'Bonjour',
  'Привет',
  'Hola',
  'Hallo',
  'Olá',
  'Ciao',
] as const;
type OnboardingStep = 'welcome' | 'language';
const selectedLanguage = ref<UiLanguage>(props.initialLanguage);
const step = ref<OnboardingStep>('welcome');
const onboardingRoot = ref<HTMLElement | null>(null);
const welcomeNextButton = ref<HTMLButtonElement | null>(null);
const languageOptionButtons = ref<HTMLButtonElement[]>([]);
const confirming = ref(false);
const celebrating = ref(false);
const errorMessage = ref('');
const pageExited = ref(false);
const context = useSettingsActionContext(() => !pageExited.value, () => [props.initialLanguage]);
const interactionContext = useSettingsActionContext(() => context.active.value && !confirming.value && !celebrating.value,
  () => [context.revision.value, step.value, selectedLanguage.value]);
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
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
  clearTransitionTimer();
  celebrating.value = false;
  errorMessage.value = '';
  focusSequence += 1;
}, {flush: 'sync'});
const languageOptions = computed(() => {
  const current = interactionContext.capture();
  const choose = (value: UiLanguage) => {
    if (!current() || step.value !== 'language') return;
    selectedLanguage.value = value;
    errorMessage.value = '';
  };
  return UI_LANGUAGE_OPTIONS.map((option, index) => ({...option,
    choose: () => choose(option.value),
    keydown: (event: KeyboardEvent) => {
      if (!current() || step.value !== 'language'
        || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? UI_LANGUAGE_OPTIONS.length - 1
        : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + UI_LANGUAGE_OPTIONS.length) % UI_LANGUAGE_OPTIONS.length;
      choose(UI_LANGUAGE_OPTIONS[nextIndex].value);
      focusCurrentStep();
    },
  }));
});
const onboardingActions = computed(() => {
  const current = interactionContext.capture();
  return {
    next: () => {if (current()) goToLanguage();},
    back: () => {if (current()) goToWelcome();},
    confirm: () => {if (current()) return confirm();},
    focus: () => {if (current()) focusCurrentStep();},
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

function focusCurrentStep(): void {
  if (!interactionContext.active.value) return;
  const current = interactionContext.capture(), before = document.activeElement, sequence = ++focusSequence;
  if (before !== document.body && !onboardingRoot.value?.contains(before)) return;
  void nextTick(() => {
    if (!current() || sequence !== focusSequence
      || (document.activeElement !== before && document.activeElement !== document.body)) return;
    const target = step.value === 'welcome' ? welcomeNextButton.value
      : languageOptionButtons.value.find(button => button.dataset.language === selectedLanguage.value);
    if (target?.isConnected && target !== document.activeElement) target.focus({preventScroll: true});
  });
}

function goToLanguage(): void {
  if (!interactionContext.active.value || step.value !== 'welcome') return;
  step.value = 'language';
  focusCurrentStep();
}

function goToWelcome(): void {
  if (!interactionContext.active.value || step.value !== 'language') return;
  step.value = 'welcome';
  focusCurrentStep();
}

async function confirm(): Promise<void> {
  if (!interactionContext.active.value || step.value !== 'language') return;
  const current = context.capture(), submittedLanguage = selectedLanguage.value;
  confirming.value = true;
  errorMessage.value = '';
  try {
    const applied = await setLanguage(submittedLanguage);
    if (applied === false || !current()) return;
    emit('saved', submittedLanguage);
    // saved 可同步使父组件关闭或替换本引导，不能在那之后再创建计时器。
    if (!current()) return;
    celebrating.value = true;
    transitionTimer = setTimeout(() => {
      transitionTimer = undefined;
      if (current() && celebrating.value) emit('confirmed', submittedLanguage);
    }, 1200);
  } catch {
    if (current()) {
      document.documentElement.lang = language.value;
      errorMessage.value = bilingualMessage('language.saveFailed');
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

function clearTransitionTimer(): void {
  if (transitionTimer !== undefined) clearTimeout(transitionTimer);
  transitionTimer = undefined;
}
function handlePageHide(): void {pageExited.value = true;}
window.addEventListener('pagehide', handlePageHide);
onBeforeUnmount(() => {
  clearTransitionTimer();
  window.removeEventListener('pagehide', handlePageHide);
});

watch(context.active, active => {if (active) focusCurrentStep();}, {immediate: true, flush: 'post'});
</script>

<style scoped>
.language-onboarding {
  position: relative;
  z-index: 20;
  display: grid;
  min-height: 460px;
  overflow: hidden;
  isolation: isolate;
}

.language-onboarding-backdrop {
  position: absolute;
  z-index: -1;
  inset: 0;
  background: var(--surface);
  animation: onboarding-backdrop-in 260ms ease-out both;
}

.language-onboarding-card {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 460px;
  display: grid;
  align-content: center;
  padding: 22px 20px 20px;
  background: var(--surface);
}

.onboarding-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.onboarding-brand img {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  box-shadow: 0 8px 18px rgba(239, 71, 118, .2);
}

.onboarding-brand strong {
  color: var(--ink);
  font-size: 17px;
  font-weight: 760;
}

/* 问候语在方形画板内错落散布；画板高度与下方文案、按钮一起控制在卡片的固定高度内，
   让欢迎、语言选择和成功三步保持同一尺寸，切换时弹窗不再伸缩。 */
.welcome-art {
  position: relative;
  height: 244px;
  margin: 0 -4px 12px;
  border: 1px solid rgba(239, 71, 118, .12);
  border-radius: 22px;
  background:
    radial-gradient(circle at 18% 30%, rgba(239, 71, 118, .18), transparent 24%),
    radial-gradient(circle at 82% 70%, rgba(95, 155, 243, .16), transparent 28%),
    linear-gradient(135deg, var(--brand-soft), var(--surface-soft));
  overflow: hidden;
}

.welcome-art::before,
.welcome-art::after {
  position: absolute;
  border-radius: 50%;
  content: '';
  opacity: .5;
}

.welcome-art::before {
  top: -32px;
  right: 18px;
  width: 88px;
  height: 88px;
  border: 1px solid rgba(243, 191, 69, .48);
}

.welcome-art::after {
  bottom: -42px;
  left: 42px;
  width: 104px;
  height: 104px;
  border: 1px solid rgba(106, 199, 185, .42);
}

.welcome-word {
  position: absolute;
  top: var(--word-y);
  left: var(--word-x);
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, .7);
  border-radius: 999px;
  color: var(--ink);
  background: rgba(255, 255, 255, .7);
  box-shadow: 0 7px 16px rgba(31, 40, 61, .08);
  font-size: 11px;
  font-weight: 760;
  white-space: nowrap;
  transform: translate(-50%, -50%) rotate(var(--word-tilt));
  animation: onboarding-word-float 3.8s ease-in-out infinite;
}

.welcome-word:nth-child(1) { --word-x: 16%; --word-y: 13%; --word-tilt: -6deg; color: #db3865; font-size: 12.5px; }
.welcome-word:nth-child(2) { --word-x: 50%; --word-y: 20%; --word-tilt: 3deg; animation-delay: -.7s; }
.welcome-word:nth-child(3) { --word-x: 30%; --word-y: 37%; --word-tilt: 2deg; animation-delay: -1.4s; }
.welcome-word:nth-child(4) { --word-x: 50%; --word-y: 61%; --word-tilt: -3deg; color: #567ed2; animation-delay: -2.1s; }
.welcome-word:nth-child(5) { --word-x: 28%; --word-y: 86%; --word-tilt: -5deg; color: #a37b0e; animation-delay: -.3s; }
.welcome-word:nth-child(6) { --word-x: 75%; --word-y: 44%; --word-tilt: -4deg; color: #657080; animation-delay: -1.8s; }
.welcome-word:nth-child(7) { --word-x: 14%; --word-y: 63%; --word-tilt: 7deg; color: #d63868; animation-delay: -2.7s; }
.welcome-word:nth-child(8) { --word-x: 67%; --word-y: 83%; --word-tilt: 4deg; color: #4a9d91; animation-delay: -1.1s; }
.welcome-word:nth-child(9) { --word-x: 86%; --word-y: 15%; --word-tilt: 8deg; color: #597fcc; animation-delay: -2.4s; }
.welcome-word:nth-child(10) { --word-x: 87%; --word-y: 66%; --word-tilt: 5deg; color: #bb6f45; animation-delay: -.9s; }

.onboarding-copy h1 {
  margin: 0;
  color: var(--ink);
  font-size: 24px;
  line-height: 1.2;
  letter-spacing: -.025em;
}

.welcome-copy h1 {
  font-size: 25px;
}

.onboarding-title-secondary {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 680;
  line-height: 1.3;
  letter-spacing: 0;
}

.welcome-copy .onboarding-title-secondary {
  font-size: 13px;
}

.onboarding-error {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.55;
}

.onboarding-confirm {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 46px;
  margin-top: 0;
  border: 0;
  border-radius: 12px;
  color: #fff;
  background: var(--brand);
  font-size: 12px;
  font-weight: 760;
  cursor: pointer;
  transition: background 160ms ease, transform 160ms ease;
}

.onboarding-confirm:hover:not(:disabled) {
  background: var(--brand-strong);
  transform: translateY(-1px);
}

.onboarding-confirm:disabled {
  cursor: wait;
  opacity: .65;
}

.onboarding-button-copy {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.onboarding-button-copy strong {
  font-size: 12px;
  font-weight: 760;
  line-height: 1.15;
}

.onboarding-button-copy small {
  font-size: 9.5px;
  font-weight: 650;
  line-height: 1.15;
  opacity: .84;
}

.onboarding-next {
  justify-content: space-between;
  margin-top: 12px;
  padding: 0 15px 0 17px;
  text-align: left;
}

.onboarding-next .onboarding-button-copy {
  align-items: flex-start;
}

.onboarding-next-arrow {
  width: 18px;
  height: 14px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: onboarding-arrow-nudge 1.15s ease-in-out infinite;
}

.onboarding-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: -2px 0 12px;
  padding: 0;
  border: 0;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.onboarding-back-arrow {
  width: 13px;
  height: 11px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.onboarding-back:hover {
  color: var(--brand-strong);
}

.onboarding-language-field {
  margin-top: 14px;
}

.onboarding-language-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.onboarding-language-option {
  position: relative;
  display: flex;
  min-height: 46px;
  align-items: center;
  padding: 8px 29px 8px 11px;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--ink);
  background: var(--surface-soft);
  text-align: left;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}

.onboarding-language-option:hover {
  border-color: rgba(239, 71, 118, .42);
  transform: translateY(-1px);
}

.onboarding-language-option:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.onboarding-language-option.selected {
  border-color: var(--brand);
  background: var(--brand-soft);
  box-shadow: 0 0 0 3px rgba(239, 71, 118, .1);
}

.onboarding-language-name {
  display: grid;
  gap: 2px;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 760;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.onboarding-language-secondary {
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
}

.onboarding-language-check {
  position: absolute;
  top: 50%;
  right: 9px;
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 50%;
  color: transparent;
  background: var(--surface);
  font-size: 10px;
  font-weight: 800;
  transform: translateY(-50%);
}

.onboarding-language-option.selected .onboarding-language-check {
  border-color: var(--brand);
  color: #fff;
  background: var(--brand);
}

.onboarding-confirm-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  margin-top: 7px;
  margin-bottom: 0;
  color: var(--brand-strong);
}

.onboarding-guide-arrow {
  width: 14px;
  height: 18px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: onboarding-point 1.05s ease-in-out infinite;
}

.onboarding-error {
  margin-top: 10px;
  color: #c52f58;
}

.onboarding-success {
  position: relative;
  min-height: 200px;
  padding: 28px 0 7px;
  text-align: center;
  overflow: hidden;
}

.onboarding-success::before,
.onboarding-success::after {
  position: absolute;
  z-index: 0;
  width: 8px;
  height: 18px;
  border-radius: 4px;
  content: '';
  opacity: .8;
  animation: onboarding-confetti 900ms ease-out 120ms both;
}

.onboarding-success::before {
  top: 26px;
  left: 12px;
  background: #ef4776;
  box-shadow: 30px -10px #f3bf45, 70px 4px #5f9bf3, 238px -8px #6ac7b9, 280px 18px #ef4776;
  transform: rotate(-22deg);
}

.onboarding-success::after {
  right: 18px;
  bottom: 54px;
  background: #6ac7b9;
  box-shadow: -35px 14px #ef4776, -78px -8px #f3bf45, -125px 16px #5f9bf3;
  transform: rotate(24deg);
}

.onboarding-success h1 {
  position: relative;
  z-index: 1;
  margin: 24px 0 0;
  color: var(--ink);
  font-size: 24px;
  line-height: 1.2;
}

.onboarding-success-mark {
  display: grid;
  width: 70px;
  height: 70px;
  margin: 0 auto;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(145deg, #ef4776, #dc315f);
  box-shadow: 0 12px 24px rgba(239, 71, 118, .28), 0 0 0 10px rgba(239, 71, 118, .1);
  animation: onboarding-success-pop 600ms cubic-bezier(.2, .8, .2, 1) both;
}

.onboarding-success-mark span {
  position: relative;
  z-index: 1;
  display: block;
  font-size: 34px;
  font-weight: 800;
  line-height: 1;
  animation: onboarding-check-in 420ms ease-out both;
}

.onboarding-content-enter-active,
.onboarding-content-leave-active {
  transition: opacity 180ms ease;
}

.onboarding-content-enter-from {
  opacity: 0;
}

.onboarding-content-leave-to {
  opacity: 0;
}

@keyframes onboarding-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes onboarding-word-float {
  0%, 100% { translate: 0 0; }
  50% { translate: 0 -2px; }
}

@keyframes onboarding-arrow-nudge {
  0%, 100% { translate: 0 0; }
  50% { translate: 4px 0; }
}

@keyframes onboarding-point {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(3px); }
}

@keyframes onboarding-confetti {
  from { opacity: 0; transform: translateY(12px) rotate(0); }
  to { opacity: .8; transform: translateY(0) rotate(24deg); }
}

@keyframes onboarding-success-pop {
  0% { transform: scale(.5) rotate(-12deg); }
  65% { transform: scale(1.08) rotate(3deg); }
  100% { transform: scale(1) rotate(0); }
}

@keyframes onboarding-check-in {
  from { opacity: 0; transform: scale(.4); }
  to { opacity: 1; transform: scale(1); }
}

@media (max-width: 360px) {
  .onboarding-language-options { gap: 5px; }
  .onboarding-language-option { padding-right: 24px; padding-left: 8px; }
  .onboarding-language-name { font-size: 10.5px; }
}

@media (prefers-reduced-motion: reduce) {
  .language-onboarding-backdrop,
  .language-onboarding-card,
  .onboarding-success::before,
  .onboarding-success::after,
  .onboarding-success-mark,
  .onboarding-success-mark span,
  .welcome-word,
  .onboarding-next-arrow,
  .onboarding-guide-arrow {
    animation: none;
  }
}
</style>
