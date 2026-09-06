<script setup lang="ts">
import { withBase } from 'vitepress'
const chrome =
  'https://chromewebstore.google.com/detail/djnlaiohfaaifbibleebjggkghlmcpcj'
</script>

<template>
  <div class="product-home">
    <section class="product-hero" aria-labelledby="product-title">
      <img
        class="product-hero-icon"
        :src="withBase('/product-icon.png')"
        width="896"
        height="880"
        alt=""
        fetchpriority="high"
      />
      <p class="product-eyebrow">Open-source browser extension</p>
      <h1 id="product-title">FluentRead</h1>
      <p class="product-intro">
        A browser extension for bilingual webpages, selection translation, AI
        reading assistance, and image, document, and subtitle translation.
      </p>
      <div class="product-actions">
        <a
          class="product-button primary"
          :href="chrome"
          target="_blank"
          rel="noopener noreferrer"
          >Add to Chrome <span aria-hidden="true">↗</span></a
        >
        <a
          class="product-button secondary"
          :href="withBase('/en/guide/getting-started#install')"
          >Other browsers <span aria-hidden="true">→</span></a
        >
      </div>
      <p class="product-foundation">
        <a href="https://github.com/FluentRead/FluentRead"
          >Open source · GPL-3.0 <span aria-hidden="true">↗</span></a
        >
        <a :href="withBase('/en/guide/deepseek-harness')"
          >DeepSeek Harness session core <span aria-hidden="true">→</span></a
        >
      </p>
      <figure class="product-main-shot">
        <a
          :href="withBase('/screenshots/en/translation.webp')"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the full-resolution bilingual reading screenshot in a new tab"
        >
          <img
            :src="withBase('/screenshots/en/translation.webp')"
            :srcset="`${withBase(
              '/screenshots/en/translation-small.webp'
            )} 1280w, ${withBase('/screenshots/en/translation.webp')} 2560w`"
            sizes="(max-width: 760px) calc(100vw - 40px), min(1104px, 92vw)"
            width="2560"
            height="1600"
            alt="A Chinese article with English translations beneath each paragraph, rendered by FluentRead"
            fetchpriority="high"
          />
        </a>
        <figcaption>
          <span>Original text and translation displayed together.</span
          ><a :href="withBase('/en/guide/getting-started')"
            >Installation guide <span aria-hidden="true">→</span></a
          >
        </figcaption>
      </figure>
    </section>

    <section class="product-story" aria-labelledby="reading-title">
      <div class="product-story-copy">
        <p class="product-eyebrow">Webpage reading</p>
        <h2 id="reading-title">Bilingual webpage translation</h2>
        <p>
          Display translations alongside the original text while retaining
          paragraph correspondence. Translate a full page, hover over a
          paragraph, or select text, and restore the original when needed.
        </p>
        <a
          class="product-text-link"
          :href="withBase('/en/guide/features#page-translation')"
          >Webpage translation guide <span aria-hidden="true">→</span></a
        >
      </div>
      <div class="product-rhythm">
        <div>
          <span>01</span>
          <h3>Open a webpage</h3>
          <p>Open a webpage in your browser.</p>
        </div>
        <div>
          <span>02</span>
          <h3>Select a language</h3>
          <p>
            Choose the target language. The source language is detected
            automatically.
          </p>
        </div>
        <div>
          <span>03</span>
          <h3>Translate and read</h3>
          <p>Display both languages on the page or restore the original.</p>
        </div>
      </div>
    </section>

    <section
      class="product-story selection-story"
      aria-labelledby="selection-title"
    >
      <figure class="product-detail-shot">
        <a
          :href="withBase('/screenshots/en/reading-card-detail.webp')"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the full-resolution AI reading card screenshot in a new tab"
          ><img
            :src="withBase('/screenshots/en/reading-card-detail.webp')"
            width="840"
            height="1140"
            loading="lazy"
            decoding="async"
            alt="FluentRead’s AI reading card explains the selected sentence and expression, with a follow-up question field"
        /></a>
        <figcaption>Contextual explanation and follow-up questions.</figcaption>
      </figure>
      <div class="product-story-copy">
        <p class="product-eyebrow">DeepSeek Harness</p>
        <h2 id="selection-title">AI reading card</h2>
        <p>
          Explain selected text, analyze sentence structure, explore usage, and
          generate practice. Follow-up questions and vocabulary collection are
          available in the card.
        </p>
        <p>
          The card integrates a browser adaptation of the DeepSeek Harness
          session core. It connects the selection, permitted paragraph context,
          and reading history to your configured AI provider and model.
        </p>
        <p class="product-subnote">
          Explanations and practice use your configured AI service and start
          when you choose an action.
        </p>
        <a
          class="product-text-link"
          :href="withBase('/en/guide/deepseek-harness')"
          >Reading card guide <span aria-hidden="true">→</span></a
        >
      </div>
    </section>

    <section class="product-more" aria-labelledby="more-title">
      <p class="product-eyebrow">Translation formats</p>
      <h2 id="more-title">Images, documents, and subtitles</h2>
      <div class="product-use-cases">
        <a :href="withBase('/en/guide/image-translation')"
          ><span class="product-case-type">Images & selected areas</span>
          <h3>Image and area translation <span aria-hidden="true">↗</span></h3>
          <p>
            Recognize text in webpage images or selected areas and display
            translations that can be copied.
          </p></a
        >
        <a :href="withBase('/en/guide/document-translation')"
          ><span class="product-case-type">Documents</span>
          <h3>Document translation <span aria-hidden="true">↗</span></h3>
          <p>
            Read PDF, ePub, Word, and other supported files in two languages,
            edit translations, and export the result.
          </p></a
        >
        <a :href="withBase('/en/guide/video-subtitles')"
          ><span class="product-case-type">Video subtitles</span>
          <h3>Bilingual subtitles <span aria-hidden="true">↗</span></h3>
          <p>
            Display bilingual subtitles on YouTube and X, with configurable
            subtitle appearance.
          </p></a
        >
      </div>
    </section>

    <section
      class="product-story product-control"
      aria-labelledby="control-title"
    >
      <div class="product-story-copy">
        <p class="product-eyebrow">Configuration</p>
        <h2 id="control-title">Services and reading settings</h2>
        <p>
          Configure automatic translation by website, translation styles,
          keyboard shortcuts, and menu layout.
        </p>
        <p>
          Choose the free translation service, connect DeepL or an AI provider,
          or use a local Ollama model.
        </p>
        <a
          class="product-text-link"
          :href="withBase('/en/config/translation-engines')"
          >Choose a translation service <span aria-hidden="true">→</span></a
        >
        <p class="product-subnote">
          Third-party services may require their own credentials or paid
          credits. Cloud translation sends the text to your chosen service.
          <a :href="withBase('/en/guide/privacy')">Data & privacy</a>
        </p>
      </div>
      <figure class="product-popup-shot">
        <a
          :href="withBase('/screenshots/en/popup.webp')"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the full-resolution extension menu screenshot in a new tab"
          ><img
            :src="withBase('/screenshots/en/popup.webp')"
            width="720"
            height="1120"
            loading="lazy"
            decoding="async"
            alt="FluentRead’s menu with target language, translation service, and reading tools"
        /></a>
      </figure>
    </section>

    <section class="product-open" aria-labelledby="open-title">
      <div>
        <p class="product-eyebrow">Source and contributions</p>
        <h2 id="open-title">An open-source project under GPL-3.0</h2>
        <p>
          The source code is hosted on GitHub. Contributions to code,
          documentation, interface translations, and website support are welcome
          through issues and pull requests.
        </p>
      </div>
      <a
        class="product-button secondary"
        href="https://github.com/FluentRead/FluentRead"
        >Source on GitHub <span aria-hidden="true">↗</span></a
      >
    </section>

    <section class="product-end" aria-labelledby="start-title">
      <p class="product-eyebrow">Chrome · Edge · Firefox</p>
      <h2 id="start-title">Installation and user guide</h2>
      <div class="product-actions">
        <a
          class="product-button primary"
          :href="withBase('/en/guide/getting-started#install')"
          >Install FluentRead <span aria-hidden="true">→</span></a
        ><a class="product-button secondary" :href="withBase('/en/guide/')"
          >Read the guide</a
        >
      </div>
      <a class="product-help-link" :href="withBase('/en/guide/faq')"
        >Help and troubleshooting</a
      >
    </section>
  </div>
</template>
