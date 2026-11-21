<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import locales from '../landing-locales.json'
import samples from './marketing-hero-copy.json'
import brandTaglines from '../../../src/core/i18n/messages/brand-taglines.json'

const props = defineProps<{ locale: keyof typeof samples }>()
const copy = computed(() => samples[props.locale])
const locale = computed(() => locales[props.locale])
const headline = computed(() => {
  if (props.locale === 'zh') return brandTaglines['zh-CN']
  if (props.locale === 'en') return brandTaglines['en-US']
  return samples[props.locale].headline
})
const englishSource = [
  'At midnight, the bookshop was still open.',
  'I picked a book by its cover and read the first page on my way home.',
]
const chineseSource = [
  '午夜了，书店还开着。',
  '我凭封面挑了本书，回来的路上就读了第一页。',
]
const source = computed(() => props.locale === 'en' ? chineseSource : englishSource)
const sourceLanguage = computed(() => props.locale === 'en' ? 'zh-CN' : 'en')
const view = ref<'original' | 'bilingual'>('bilingual')
const firstReveal = ref(true)

function chooseView(next: typeof view.value) {
  firstReveal.value = false
  view.value = next
}

watch(() => props.locale, () => {
  view.value = 'bilingual'
  firstReveal.value = true
})
</script>

<template>
  <section :key="locale.lang" class="fr-marketing-hero" aria-labelledby="fr-hero-title">
    <div class="fr-hero-grid">
      <div class="fr-hero-copy">
        <h1 id="fr-hero-title">{{ headline }}</h1>
        <p>{{ locale.description }}</p>
        <slot />
      </div>
      <article
        class="fr-sample-reader"
        :data-view="view"
        :data-first-reveal="firstReveal"
        :aria-label="copy.example"
      >
        <header>
          <span>{{ copy.example }}</span>
          <div class="fr-reader-switch" role="group" :aria-label="copy.example">
            <button type="button" :aria-pressed="view === 'original'" @click="chooseView('original')">
              {{ copy.original }}
            </button>
            <button type="button" :aria-pressed="view === 'bilingual'" @click="chooseView('bilingual')">
              {{ copy.bilingual }}
            </button>
          </div>
        </header>
        <div class="fr-reader-page">
          <div v-for="(text, index) in source" :key="text" class="fr-reader-paragraph">
            <p class="fr-source" :lang="sourceLanguage">{{ text }}</p>
            <div class="fr-translation" :aria-hidden="view === 'original' ? 'true' : undefined">
              <div class="fr-translation-clip">
                <p><span>{{ index === 0 ? copy.exampleTitle : copy.exampleText }}</span></p>
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.fr-marketing-hero {
  color: #25211d;
  background: #faf7ee;
  border-block: 1px solid #eae2d2;
}
.fr-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.88fr) minmax(0, 1.12fr);
  align-items: center;
  gap: clamp(24px, 5vw, 76px);
  max-width: 1160px;
  min-height: 505px;
  margin: auto;
  padding: clamp(42px, 7vw, 90px) clamp(20px, 5vw, 48px);
}
.fr-hero-copy h1 {
  font-family: 'Iowan Old Style', Baskerville, 'Songti SC', 'Yu Mincho', Georgia, serif;
  font-size: clamp(2.35rem, 4.4vw, 3.7rem);
  font-weight: 650;
  letter-spacing: -0.033em;
  line-height: 1.13;
  text-wrap: balance;
  overflow-wrap: anywhere;
}
.fr-hero-copy > p {
  max-width: 43ch;
  margin-block: 19px 24px;
  letter-spacing: -0.005em;
  color: #5c5148;
}
.fr-hero-copy :deep(.bv-install) {
  align-items: flex-start;
}
.fr-hero-copy :deep(.bv-install-actions),
.fr-hero-copy :deep(.bv-install-fallbacks) {
  justify-content: flex-start;
  text-align: start;
}
.fr-hero-copy :deep(.bv-install-actions) {
  max-width: 100%;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 9px;
}
.fr-hero-copy :deep(.bv-install-actions .bv-button) {
  min-height: 44px;
  padding: 8px 12px;
  border-radius: 8px;
  box-shadow: none;
  font-size: 0.875rem;
}
.fr-hero-copy :deep(.bv-install-actions .bv-docs-link) {
  border-color: transparent;
  background: transparent;
  color: #872349;
  text-decoration: underline;
  text-underline-offset: .22em;
}
.fr-sample-reader {
  position: relative;
  padding-block: 2px 4px;
  border-block: 2px solid #332925;
}
.fr-sample-reader header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-block: 10px;
  border-bottom: 1px solid #d7ccba;
  color: #5e5048;
  font-size: 0.82rem;
  font-weight: 600;
}
.fr-reader-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}
.fr-reader-switch button {
  min-height: 34px;
  padding: 4px 7px;
  border-bottom: 2px solid transparent;
  text-align: start;
  transition: color .22s ease, border-color .22s ease;
}
.fr-reader-switch [aria-pressed='true'] {
  color: #9d204c;
  border-color: #db4978;
}
.fr-reader-switch button:focus-visible {
  outline: 2px solid #ae2257;
  outline-offset: 2px;
}
.fr-reader-page {
  padding-block: clamp(22px, 3vw, 34px);
}
.fr-reader-paragraph + .fr-reader-paragraph {
  margin-top: clamp(13px, 2vw, 21px);
}
.fr-source {
  font-family: 'Iowan Old Style', Baskerville, 'Songti SC', 'Yu Mincho', Georgia, serif;
  font-size: 1.14rem;
  line-height: 1.56;
  color: #29221d;
}
.fr-reader-paragraph:first-child .fr-source {
  font-size: clamp(1.55rem, 2.7vw, 2rem);
  line-height: 1.28;
  font-weight: 600;
}
.fr-translation {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  transform: translateY(0);
  transition: grid-template-rows .46s cubic-bezier(.22,.8,.24,1),
    opacity .35s ease, transform .46s cubic-bezier(.22,.8,.24,1);
}
.fr-translation-clip {
  min-height: 0;
  overflow: hidden;
}
.fr-translation p {
  margin-top: 8px;
  color: #7a213f;
  font-size: 0.97rem;
  line-height: 1.67;
}
.fr-translation span {
  padding: 2px 4px;
  background: #ffdbe2;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.fr-sample-reader[data-view='original'] .fr-translation {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(-4px);
}
.fr-sample-reader[data-view='bilingual'] .fr-reader-paragraph + .fr-reader-paragraph .fr-translation {
  transition-delay: .10s;
}
@media (prefers-reduced-motion: no-preference) {
  .fr-sample-reader {
    animation: fr-reader-arrive .78s cubic-bezier(.2,.76,.22,1) both;
  }
  .fr-sample-reader[data-first-reveal='true'] .fr-translation p {
    animation: fr-translation-arrive .63s cubic-bezier(.22,.8,.24,1) .32s both;
  }
  .fr-sample-reader[data-first-reveal='true'] .fr-reader-paragraph + .fr-reader-paragraph .fr-translation p {
    animation-delay: .56s;
  }
}
@keyframes fr-reader-arrive {
  from { transform: translateY(10px); opacity: .74; }
  to { transform: translateY(0); opacity: 1; }
}
@keyframes fr-translation-arrive {
  from { opacity: 0; transform: translateY(-5px); clip-path: inset(0 0 92% 0); }
  to { opacity: 1; transform: translateY(0); clip-path: inset(0); }
}
@media (prefers-reduced-motion: reduce) {
  .fr-translation, .fr-reader-switch button {
    transition: none !important;
  }
}
@media (max-width: 760px) {
  .fr-hero-grid {
    grid-template-columns: minmax(0, 1fr);
    min-height: auto;
  }
}
</style>
