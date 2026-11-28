# Feature overview

Browse every core capability of FluentRead by reading or work scenario. New here? Start with the [Quick start guide](/en/guide/getting-started).

<DocDiagram kind="ecosystem-map" en />

<span id="page-floating-button"></span>
<span id="buttons-and-action-text-translation-only"></span>
<span id="translate-menus-and-dynamic-ui"></span>
<span id="time-numbers-and-changing-content"></span>
<span id="adjust-paragraph-processing"></span>
<span id="right-click-translation"></span>
<span id="page-floating-ball"></span>
<span id="buttons-show-the-translation-only"></span>
<span id="missing-menus-or-interface-text"></span>
<span id="times-numbers-and-changing-content"></span>
<span id="tune-how-paragraphs-are-handled"></span>

## Webpage & daily translation

<GuideVisual kind="webpage" en />

| Feature | Summary | Guide |
| --- | --- | --- |
| **Page translation** | Display translations below original paragraphs or switch to Translation only, plus one-click paper shortcuts | [Page & section translation](/en/guide/webpage-translation) |
| **Section translation** | Click **Section** or press `Alt+R` to lock a specific block, README, or comment thread—and remember it | [Section translation steps](/en/guide/webpage-translation#section-translation) |
| **Selection translation** | Open an instant card with translation, English dictionaries, multi-source TTS, AI explanations, and saving | [Selection translation](/en/guide/deepseek-harness) |
| **Hover translation** | Point at any paragraph and press `Control` to translate or restore just that paragraph | [Hover translation](/en/guide/hover-translation) |
| **Input translation** | Translate drafts inside chat or email boxes via triple-key or shortcut—never sends automatically | [Input translation](/en/guide/input-translation) |
| **Translation Center & sidebar** | Compare multiple providers on the same passage or paste text into the browser sidebar | [Translation Center](/en/guide/translation-center) |
| **Smart Highlighting** | On-device keyword and surprisal highlighting to help skim dense articles | [Smart Highlighting](/en/guide/information-highlight) |

<span id="section-translation"></span>
<span id="images-files-and-subtitles"></span>

## Images, documents & video

| Feature | Summary | Guide |
| --- | --- | --- |
| **Image & manga translation** | On-device PaddleOCR + LaMa background inpainting, single-image translation, continuous manga prefetch & text panel | [Image & manga translation](/en/guide/image-translation) |
| **Area translation** | Press `Shift+Z` to crop charts, screenshots, or paused video frames with Vision AI or local OCR | [Area translation](/en/guide/area-translation) |
| **Document translation** | 14 formats including PDF, EPUB, DOCX, Markdown, CSV & subtitles; original/reflow PDF views, OCR & annotations | [Document translation](/en/guide/document-translation) |
| **Video & meeting captions** | Bilingual captions for YouTube, Bilibili, X, courses, Meet/Teams/Zoom & HTML media, plus local Whisper ASR | [Video & meeting captions](/en/guide/video-subtitles) |

<span id="translation-center-compare-services"></span>
<span id="english-word-lookup"></span>
<span id="ai-reading-card-and-learning-center"></span>

## Learning & expression

| Feature | Summary | Guide |
| --- | --- | --- |
| **Learning center** | Save words, sentences & reading materials, review with spaced repetition, export Anki, and re-encounter on new pages | [Learning center](/en/guide/vocabulary-book) |
| **Dictionaries & study cards** | Import offline MDict/StarDict/DSL/Yomitan dictionaries, custom JSON APIs, and AnkiConnect card templates | [Dictionaries & study cards](/en/guide/dictionaries) |
| **Sentence structure** | Interactive breakdown of sentence clauses, syntactic roles, and parts of speech | [Sentence structure](/en/guide/sentence-analysis) |
| **Bilingual share cards** | Generate styled quote images locally with original, translation, and source | [Bilingual share cards](/en/guide/share-cards) |
| **Writing assistant** | Draft or refine replies beside Gmail and GitHub editors, review, and insert manually | [Writing assistant](/en/guide/writing-assistant) |

<span id="your-service-and-settings"></span>

## Providers, privacy & customization

| Feature | Summary | Guide |
| --- | --- | --- |
| **Translation providers** | Free pool out of the box, plus cloud APIs, AI models, combo fallback, Ollama, and offline local models per feature | [Translation providers](/en/config/translation-engines) |
| **Translation privacy shield** | Locally detect and redact emails, phones, keys, or custom terms—or block requests before sending | [Translation privacy shield](/en/config/privacy-protection) |
| **Appearance & reading aids** | Bilingual style presets, custom CSS, popup skins, and synchronized sentence highlighting | [Appearance & reading aids](/en/config/appearance) |
| **Glossaries** | Enforce preferred translations or keep terms untranslated, with automatic candidate extraction from papers | [Glossaries](/en/guide/glossary) |
| **Site rules & reading area** | Set per-site Auto-translate, Translation-only, Disable, or custom CSS content selectors | [Site rules & reading area](/en/config/site-adaptation) |
| **Backup, sync & analytics** | Local full backups, 6-hour auto snapshots, Google Drive / WebDAV sync, latency stats & AI token usage | [Backup & sync](/en/config/backup-sync) |

### Request limits {#request-limits}

If a provider reports rate limiting, reduce concurrency or requests per second under [Request limits](/en/config/#request-limits).
