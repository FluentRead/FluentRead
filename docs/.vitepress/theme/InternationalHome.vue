<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { withBase } from 'vitepress'
import locales from '../landing-locales.json'
import copies from './international-home-copy.json'
import BrowserGlyph from './BrowserGlyph.vue'
import { browserStores } from './browser-stores'
import paperArt from '../assets/bilingual-paper.jpg'

const props = defineProps<{ locale: keyof typeof copies }>()
const locale = computed(() => locales[props.locale])
const copy = computed(() => copies[props.locale])
const bilingual = ref(true)
watch(() => props.locale, () => { bilingual.value = true })
</script>

<template>
  <div class="fr-international-home">
    <section class="fr-intro" aria-labelledby="fr-intro-title">
      <img
        class="fr-intro-art"
        :src="paperArt"
        width="1400"
        height="788"
        alt=""
        fetchpriority="high"
      />
      <div class="fr-intro-grid">
        <div class="fr-intro-copy">
          <h1 id="fr-intro-title">{{ copy.headline }}</h1>
          <p>{{ locale.description }}</p>
          <div class="fr-install-actions">
            <a class="fr-primary" :href="browserStores.Chrome + '?hl=' + locale.lang">
              <BrowserGlyph browser="Chrome" />{{ copy.addChrome }}
            </a>
            <a :href="browserStores.Edge + '?hl=' + locale.assetLocale">
              <BrowserGlyph browser="Edge" />Edge
            </a>
            <a :href="browserStores.Firefox.replace('/firefox/', '/' + locale.lang + '/firefox/')">
              <BrowserGlyph browser="Firefox" />Firefox
            </a>
          </div>
          <a class="fr-mobile-link" :href="withBase('/en/guide/mobile-safari')" hreflang="en">
            {{ copy.mobile }}
          </a>
        </div>
        <article class="fr-try" :aria-label="copy.example">
          <div class="fr-try-controls" role="group" :aria-label="copy.example">
            <button type="button" :aria-pressed="!bilingual" @click="bilingual = false">
              {{ copy.original }}
            </button>
            <button type="button" :aria-pressed="bilingual" @click="bilingual = true">
              {{ copy.bilingual }}
            </button>
          </div>
          <p class="fr-sample-source" lang="en">A little curiosity goes a long way.</p>
          <p v-show="bilingual" class="fr-sample-translation">{{ copy.exampleTitle }}</p>
          <p class="fr-sample-source" lang="en">Start with a question about something you know. The answer might lead you somewhere you did not expect.</p>
          <p v-show="bilingual" class="fr-sample-translation">{{ copy.exampleText }}</p>
          <p class="fr-sample-caption">{{ copy.example }}</p>
        </article>
      </div>
    </section>

    <section id="features" class="fr-intl-features" aria-labelledby="fr-intl-features-title">
      <h2 id="fr-intl-features-title">{{ copy.featuresTitle }}</h2>
      <ul>
        <li v-for="item in copy.features" :key="item.title">
          <h3>{{ item.title }}</h3>
          <p>{{ item.description }}</p>
        </li>
      </ul>
    </section>
    <footer class="fr-intl-footer">
      <p>{{ copy.free }}</p>
      <div>
        <a href="https://github.com/FluentRead/FluentRead">{{ copy.source }}</a>
        <a :href="withBase('/en/guide/privacy')" hreflang="en">{{ copy.privacy }}</a>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.fr-intro {
  position: relative;
  isolation: isolate;
  color: #fff7fc;
  background: #241022;
}
.fr-intro::after,
.fr-intro-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
}
.fr-intro-art {
  object-fit: cover;
  object-position: center 53%;
}
.fr-intro::after {
  content: '';
  background: linear-gradient(90deg, #241022 0%, #241022ef 34%, #24102273 100%);
}
.fr-intro-grid,
.fr-intl-features,
.fr-intl-footer {
  max-width: 1180px;
  margin: auto;
  padding-inline: clamp(20px, 5vw, 48px);
}
.fr-intro-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(24px, 5vw, 72px);
  padding-block: clamp(44px, 9vw, 110px);
}
.fr-intro h1 {
  font-size: clamp(2rem, 4.3vw, 3.8rem);
  letter-spacing: -0.035em;
  line-height: 1.11;
  font-weight: 750;
  overflow-wrap: anywhere;
}
.fr-intro-copy p {
  color: #efd4e2;
  margin-block: 22px;
  max-width: 45ch;
}
.fr-install-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.fr-install-actions a {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  min-height: 44px;
  font-weight: 650;
  border-radius: 9px;
  border: 1px solid #dca5bf;
  background: #3e1c35;
}
.fr-install-actions .fr-primary {
  color: #27101d;
  background: #ff98bd;
  border-color: #ff98bd;
}
.fr-install-actions a:hover {
  color: #27101d;
  background: #ffe1ed;
}
.fr-install-actions :deep(svg) {
  width: 20px;
  height: 20px;
  flex: none;
}
.fr-mobile-link {
  display: inline-block;
  margin-top: 19px;
  color: #efd4e2;
  text-decoration: underline;
  text-underline-offset: 0.2em;
  font-size: 0.9rem;
}
.fr-try {
  color: #2b1829;
  background: #fffaf8;
  border: 1px solid #f2dce4;
  border-radius: 20px;
  padding: clamp(16px, 3vw, 28px);
  box-shadow: 0 18px 50px #210f234d;
}
.fr-try-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 22px;
}
.fr-try-controls button {
  min-height: 36px;
  padding: 4px 13px;
  border: 1px solid #ddc2cf;
  border-radius: 7px;
  font-size: 0.9rem;
  text-align: start;
}
.fr-try-controls [aria-pressed='true'] {
  color: #881740;
  background: #f9e4ed;
  border-color: #c95f8a;
  font-weight: 650;
}
.fr-sample-source {
  line-height: 1.55;
  margin-top: 15px;
}
.fr-sample-source:first-of-type {
  font-size: clamp(1.2rem, 2vw, 1.55rem);
  font-weight: 700;
}
.fr-sample-translation {
  padding-inline-start: 13px;
  margin-top: 7px;
  border-inline-start: 3px solid #df638e;
  color: #891b45;
}
.fr-sample-caption {
  margin-top: 20px;
  border-top: 1px solid #eed9e1;
  padding-top: 11px;
  font-size: 0.85rem;
  color: #695263;
}
.fr-intl-features {
  padding-block: clamp(42px, 7vw, 76px);
}
.fr-intl-features h2 {
  font-size: clamp(1.45rem, 3vw, 2rem);
  font-weight: 700;
  margin-bottom: 21px;
}
.fr-intl-features ul {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.fr-intl-features li {
  padding: 20px;
  border: 1px solid #eedee5;
  border-radius: 14px;
  background: #fff8f7;
}
.fr-intl-features h3 {
  font-size: 1.05rem;
  font-weight: 700;
  color: #2b1829;
}
.fr-intl-features p {
  margin-top: 7px;
  color: #634a5b;
}
.fr-intl-footer {
  padding-block: 18px 35px;
  border-top: 1px solid #eadce3;
  font-size: 0.9rem;
  color: #634a5b;
}
.fr-intl-footer div {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-top: 10px;
}
.fr-intl-footer a {
  text-decoration: underline;
  text-underline-offset: 0.2em;
  color: #911b46;
}
.fr-international-home :is(a, button):focus-visible {
  outline: 2px solid #c42a65;
  outline-offset: 4px;
}
@media (max-width: 760px) {
  .fr-intro-grid,
  .fr-intl-features ul {
    grid-template-columns: minmax(0, 1fr);
  }
  .fr-intro::after {
    background: linear-gradient(180deg, #241022 0%, #241022df 41%, #24102255 100%);
  }
}
</style>
