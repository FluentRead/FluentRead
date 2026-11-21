<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'
import locales from '../landing-locales.json'
import copies from './international-home-copy.json'
import BrowserGlyph from './BrowserGlyph.vue'
import MarketingHero from './MarketingHero.vue'
import { browserStores } from './browser-stores'

const props = defineProps<{ locale: keyof typeof copies }>()
const locale = computed(() => locales[props.locale])
const copy = computed(() => copies[props.locale])
</script>

<template>
  <div class="fr-international-home">
    <MarketingHero :locale="props.locale">
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
    </MarketingHero>
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
  border: 1px solid #e1cdd4;
  background: #fffdfc;
}
.fr-install-actions .fr-primary {
  color: white;
  background: #b8214e;
  border-color: #b8214e;
}
.fr-install-actions a:hover {
  color: #8e2048;
  background: #f9e8ee;
}
.fr-install-actions .fr-primary:hover {
  color: white;
  background: #9d1a42;
}
.fr-install-actions :deep(svg) {
  width: 20px;
  height: 20px;
  flex: none;
}
.fr-mobile-link {
  display: inline-block;
  margin-top: 17px;
  color: #725562;
  text-decoration: underline;
  text-underline-offset: 0.2em;
  font-size: 0.88rem;
}
.fr-intl-features,
.fr-intl-footer {
  max-width: 1160px;
  margin: auto;
  padding-inline: clamp(20px, 5vw, 48px);
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
.fr-international-home a:focus-visible {
  outline: 2px solid #c42a65;
  outline-offset: 4px;
}
@media (max-width: 760px) {
  .fr-intl-features ul {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
