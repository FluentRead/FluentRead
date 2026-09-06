<script setup lang="ts">
import { withBase } from 'vitepress'
const chrome =
  'https://chromewebstore.google.com/detail/djnlaiohfaaifbibleebjggkghlmcpcj'
</script>

<template>
  <div class="product-home">
    <section class="product-hero" aria-labelledby="product-title">
      <p class="product-eyebrow">FluentRead</p>
      <h1 id="product-title">
        Another language?<br /><span>Keep reading.</span>
      </h1>
      <p class="product-intro">
        Found something good to read? Don’t let the language put you off.<br />Read
        it in two languages, check a tricky sentence, and keep a phrase you
        like.
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
          <span>Original above, translation below. Easy to compare.</span
          ><a :href="withBase('/en/guide/getting-started')"
            >Give it a try <span aria-hidden="true">→</span></a
          >
        </figcaption>
      </figure>
    </section>

    <section class="product-story" aria-labelledby="reading-title">
      <div class="product-story-copy">
        <p class="product-eyebrow">Read the whole thing</p>
        <h2 id="reading-title">Long article?<br />One paragraph at a time.</h2>
        <p>
          News, posts, papers—pick up where you left off. The translation stays
          beside the original, so names, terms, and details are easy to compare.
          Done with the translation? Restore the original.
        </p>
        <a
          class="product-text-link"
          :href="withBase('/en/guide/features#page-translation')"
          >Explore bilingual reading <span aria-hidden="true">→</span></a
        >
      </div>
      <div class="product-rhythm">
        <div>
          <span>01</span>
          <h3>Open something interesting</h3>
          <p>A story, a post, a page you want to understand.</p>
        </div>
        <div>
          <span>02</span>
          <h3>Choose “Translate page”</h3>
          <p>Pick a language and read beside the original.</p>
        </div>
        <div>
          <span>03</span>
          <h3>Read at your own pace</h3>
          <p>Keep going, check a paragraph, or restore the page.</p>
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
        <figcaption>
          Meaning, expressions, and a place to keep asking.
        </figcaption>
      </figure>
      <div class="product-story-copy">
        <p class="product-eyebrow">DeepSeek Harness inside the reading card</p>
        <h2 id="selection-title">This sentence.<br />Tell me more.</h2>
        <p>
          You get the gist, but why say it that way? Select it and let the
          reading card unpack the sentence or explain the expression. Save the
          good ones to your learning center and try using them yourself.
        </p>
        <p>
          The card uses a browser adaptation of the DeepSeek Harness session
          core. Ask about the sentence, bring in its paragraph, and keep the
          conversation going with your chosen AI model.
        </p>
        <p class="product-subnote">
          Explanations and practice use your configured AI service and start
          when you choose an action.
        </p>
        <a
          class="product-text-link"
          :href="withBase('/en/guide/deepseek-harness')"
          >Meet the reading card <span aria-hidden="true">→</span></a
        >
      </div>
    </section>

    <section class="product-more" aria-labelledby="more-title">
      <p class="product-eyebrow">There’s more to read</p>
      <h2 id="more-title">Pictures, files, videos. Those too.</h2>
      <div class="product-use-cases">
        <a :href="withBase('/en/guide/image-translation')"
          ><span class="product-case-type">Images & selected areas</span>
          <h3>
            Can’t select it? Draw around it. <span aria-hidden="true">↗</span>
          </h3>
          <p>
            Translate an image or draw around a small area to get text you can
            copy.
          </p></a
        >
        <a :href="withBase('/en/guide/document-translation')"
          ><span class="product-case-type">Documents</span>
          <h3>
            Drop in a file. Take your time. <span aria-hidden="true">↗</span>
          </h3>
          <p>
            Open a PDF, ePub, or Word file. Read both languages, edit the
            translation, and download it.
          </p></a
        >
        <a :href="withBase('/en/guide/video-subtitles')"
          ><span class="product-case-type">Video subtitles</span>
          <h3>Watch with both languages. <span aria-hidden="true">↗</span></h3>
          <p>
            Read bilingual subtitles on YouTube and X, with the display set just
            how you like it.
          </p></a
        >
      </div>
    </section>

    <section
      class="product-story product-control"
      aria-labelledby="control-title"
    >
      <div class="product-story-copy">
        <p class="product-eyebrow">Your reading habits</p>
        <h2 id="control-title">Make yourself<br />comfortable.</h2>
        <p>
          Translate your usual sites automatically. Hide buttons you don’t use.
          Change how translations look and move the menu around until it feels
          right.
        </p>
        <p>
          Start with the ready-to-use free service. If you have a favorite,
          connect DeepL, an AI service, or a local Ollama model.
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
        <p class="product-eyebrow">Open source · GPL-3.0</p>
        <h2 id="open-title">The code is yours to explore.</h2>
        <p>
          Have a look around, change something, or bring an idea. FluentRead is
          built in the open, with room for more people to make reading feel
          right.
        </p>
      </div>
      <a
        class="product-button secondary"
        href="https://github.com/FluentRead/FluentRead"
        >Explore on GitHub <span aria-hidden="true">↗</span></a
      >
    </section>

    <section class="product-end" aria-labelledby="start-title">
      <p class="product-eyebrow">Got a page in mind?</p>
      <h2 id="start-title">Open it. Give it a go.</h2>
      <div class="product-actions">
        <a
          class="product-button primary"
          :href="withBase('/en/guide/getting-started#install')"
          >Get FluentRead <span aria-hidden="true">→</span></a
        ><a class="product-button secondary" :href="withBase('/en/guide/')"
          >Read the guide</a
        >
      </div>
      <a class="product-help-link" :href="withBase('/en/guide/faq')"
        >Already installed and stuck on something?</a
      >
    </section>
  </div>
</template>
