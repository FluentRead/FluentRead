# Troubleshooting & FAQ

Before diving in, verify two basics: (1) the master extension toggle is on, and (2) you refreshed the webpage after installing or updating FluentRead. Browse common solutions by topic below.

## 1. Basics & webpage translation

### Nothing happens when clicking “Translate”

1. Verify the master switch is on and your **target language** differs from the page language.
2. Browser settings pages (`chrome://`, `edge://`) and extension stores block scripts—test on a normal article.
3. Run **Check connection** under **Settings → Translation providers**, or [switch providers](/en/config/translation-engines) if a free node is busy.

### Only part of the page translates

Translation runs progressively as you scroll by default. If menus, buttons, or main content are still skipped, check [Site rules & reading area](/en/config/site-adaptation); for text inside images or charts, use [Image translation](/en/guide/image-translation) or [Area translation](/en/guide/area-translation).

### Selection works, but full-page translation does not

Test a single paragraph with hover translation, then check [Site rules & reading area](/en/config/site-adaptation) and provider rate limits under [Request limits](/en/config/#request-limits).

### How do I restore the original or apply a new language/provider?

Click **Restore** in the popup (or press `Alt+T` / `Option+T`). After changing target language, provider, or base style, restore original first and translate again.

### Why did Japanese appear inside a Chinese translation?

Verify your target language, restore, and retry. When a provider returns the wrong language for an entire passage, FluentRead retries or switches free candidates without caching broken output; short brand names or quotes may stay in their original script.

### Can FluentRead translate webmail bodies?

Yes—legacy QQ Mail reading views and NetEase 163 / 126 / yeah JS6 reading views are supported (compose editors are left alone). Open an individual message and trigger full-page or selection translation.

## 2. Selection, AI explanations & specific sites

### Selection does not respond on DeepSeek pages

Confirm **Selection translation** is enabled, update FluentRead, refresh DeepSeek, and select ordinary text inside an answer. FluentRead allows explicit user selections inside DeepSeek’s page-level `notranslate` wrapper while keeping inputs and hidden elements protected.

### Why aren’t AI explanations showing in the selection card?

Selection cards default to fast translation and dictionary lookup without calling AI automatically. Enable **AI explanations** under [Selection translation settings](/en/guide/deepseek-harness), or click **Free AI explanations** in the card to try the keyless Bilibili option.

## 3. Images, video & local models

### Image translation stays on “Preparing”

Local OCR downloads model files on first use (PaddleOCR ~30 MB by default). Confirm the prompt and verify your source language, or enable **Prefer model vision** in [Area translation](/en/guide/area-translation).

### Video captions do not appear

Verify **Video subtitle translation** is enabled and the video provides native captions. For captionless X, Bilibili, or HTML media, trigger local AI transcription manually from the player menu (see [Video & meeting captions](/en/guide/video-subtitles)).

### Where are local models stored? Does uninstalling delete them?

- By default, models stay in your browser’s extension cache and can be deleted individually in model settings.
- If **Share models across browsers** is enabled, files live in your chosen local folder and are **not** deleted when uninstalling or disconnecting.
- Chrome/Edge built-in language packs are managed by the browser; manually extracted offline extension folders must be removed manually.

### Do local models reload on every request or stay in memory forever? {#do-local-models-reload-on-every-request-or-stay-in-memory-forever}

Disk storage is separate from runtime RAM. Local translation, TTS, Whisper ASR, and OCR reuse loaded instances and **automatically unload when idle** (~1 minute on low-memory devices, ~3 minutes on standard devices, ~2 minutes when memory info is unavailable; active jobs are never interrupted). Unloading memory never deletes downloaded files. Built-in browser models and Ollama manage their own memory lifecycle.

## 4. API keys & connection errors

### Where do I enter API keys, and why does connection fail?

Open **Settings → Translation providers**, pick your provider, enter endpoint/key/model, and run **Check connection**:

- Consumer chat plans rarely include API credits—verify billing in the provider’s API console.
- An HTTP 404 returning an HTML page usually means an incorrect endpoint path rather than an invalid key.
- Ollama requires running locally with pulled models and allowed extension origin. See [Translation providers](/en/config/translation-engines).

## 5. Layout conflicts & backups

### Duplicate translations or broken layout

Restore the original, disable built-in browser translation and other translation extensions so only FluentRead translates the page, then retry.

### Translations disappear when using Font Rendering scripts

Update FluentRead and refresh. If conflicts persist, temporarily disable bold-correction in the font script and report both versions with a public test URL.

### Can I still import older backups?

Import legacy JSON configs or backups under **Settings → Backup & restore → Local backup** and review the preview first (full backups are unencrypted and may contain API keys—keep them private). See [Backup & sync](/en/config/backup-sync).

## Still stuck?

Open an issue on [GitHub Issues](https://github.com/FluentRead/FluentRead/issues) with:

1. Browser and FluentRead version numbers;
2. A public URL and clear reproduction steps;
3. Error codes or screenshots with all private data, cookies, and API keys removed.
