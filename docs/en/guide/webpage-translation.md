# Page & section translation

Read translations directly below original paragraphs on any webpage, or target a single section or comment thread, and restore the original anytime.

<GuideVisual kind="webpage" en />

<DocDiagram kind="webpage-modes" en />

## Page translation

1. Open an article and click FluentRead in the browser toolbar (or press `Alt+T` / `Option+T`).
2. Confirm your **target language** and **translation provider**, then click **Translate**.
3. Read in bilingual mode by default:
   - Use the display-mode toggle at the bottom right of the translation card to switch between **Bilingual** and **Translation only** immediately without new API requests.
   - Click **Restore** anytime to return to the original text and end the session.
   - Press `Esc` in the popup service picker to step back to the overview, and again to return to the popup home screen.

### Helpful details

- **Per-site translation-only mode:** Enable **Translation only** for specific domains under **Tools & learning → Website rules → Site preferences** while keeping bilingual mode globally (see [Site rules & reading area](/en/config/site-adaptation)).
- **Quick readable font toggle (Aa):** Click **Aa** at the bottom right of the card to switch translations to your browser’s default font; click again to revert. This preference saves globally and applies immediately.
- **Scroll-based translation & deduplication:** Visible paragraphs translate as you scroll (including newly expanded comments and dynamically loaded content). Identical passages on the same page share results, and enabling translation cache reuses results across batches and re-translations when parameters match.
- **Smart skipping & formatting:** Passages already in the target or excluded languages stay untranslated; Simplified/Traditional Chinese still converts when characters differ; `<del>` strikethrough formatting is preserved in bilingual translations.

<details class="guide-details">
<summary>See a real webpage translation screenshot</summary>

<figure class="doc-figure"><a href="/screenshots/en/translation.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/en/translation.webp" width="2560" height="1600" alt="Chinese paragraphs followed by English translations on the same webpage" loading="lazy" /></a><figcaption>Originals and translations appear paragraph by paragraph. Click to view the full-size screenshot.</figcaption></figure>

</details>

## Read research papers

The browser extension adds direct reading entries on major academic sites:

| Platform | Action button | Behavior |
| --- | --- | --- |
| **arXiv (HTML available)** | **Bilingual translation (FluentRead)** | Opens the official HTML version in a new tab and translates from your reading position while keeping TOC, math, and citations intact |
| **PubMed Central** | **Bilingual translation (FluentRead)** | Translates the full article directly in place |
| **Hugging Face Papers / ACL Anthology / CVF / NeurIPS / PDF-only arXiv** | **Read PDF (FluentRead)** | Opens the original PDF in the [Document reader](/en/guide/document-translation) |

## Section translation {#section-translation}

When you only want to translate a main article, README, or comment thread:

1. Click **Section** beside **Translate** (or enable `Alt+R` / `Option+R` under **Settings → Translation → Section translation**).
2. Move your pointer to preview highlighted regions and click to lock—or drag across multiple paragraphs and release.
3. Adjust with **Expand / Shrink selection** or `↑ / ↓`, then click **Translate selected section** or press `Enter`.

- **Safe picking:** Links and page buttons do not trigger while picking; hover previews wait briefly to avoid flicker; press `Esc`, right-click, or click Close to exit.
- **Restore or retry a section:** Pick an already-translated section and confirm **Restore original** to revert only that block, or confirm translation again to retry failed passages.
- **Headers & sidebars:** Full-page mode usually skips headers and sidebars, while explicitly picking them translates their labels in translation-only style to preserve layout.

### Remember a section

After locking a section, check **Remember this section**:

1. Choose scope: **Current directory** or **Entire site**.
2. Choose next-visit behavior: **Remind me** (default) or **Translate automatically**.
3. Click **Translate and remember** to save (multiple dragged sections can be saved together).

Manage up to 100 saved rules (including independent provider profiles) under **Section translation → Remembered sections**.

## AI context and terminology

Open **Translation services → AI context** in the popup and select a supported AI provider so new translations can reference the page topic, current heading, nearby paragraphs, and prior definitions.

- Off by default; enabling it sends extra page context (which may increase token usage) and applies to new translations after restoring and re-translating.
- Short references are used directly without an extra summary call; longer pages generate a concise cached summary. Pair with [AI multi-segment translation](/en/config/translation-engines#ai-context-and-multi-segment-translation) to share context across adjacent blocks.
- For strict terminology or keeping terms untranslated, use [Glossaries](/en/guide/glossary) (works with both machine and AI providers).

## Continue after a failure

- **Retry failed passages:** Click any failed paragraph directly, or enable the **Full-page progress panel** to **Locate failed passage** or **Retry failed items** without losing completed translations.
- **Rate-limit cooldown:** If a provider returns a cooldown period, retrying early displays the remaining wait time.
- **Dialogs & navigation:** Blocking modal dialogs translate first before resuming the main page; restoring cancels all pending requests cleanly.
- Missing article body? Check [Site rules & reading area](/en/config/site-adaptation). Text inside images or charts? Use [Image translation](/en/guide/image-translation) or [Area translation](/en/guide/area-translation).

<details class="guide-details">
<summary>Personal corrections: edit webpage translations locally</summary>

### Personal corrections

Enable **Personal corrections** under **Settings → Translation → Reading assistance** (off by default). Hover a bilingual translation and click **Edit translation**, or press `Alt+Shift+E`, preview affected sentences, and confirm.

- **Scope:** Defaults to **Only this webpage** (distinct URLs/queries/hashes stay separate). Create a project to reuse exact matches across related pages.
- **Storage & limits:** Local only (up to 1,000 records and 100 projects), excluded from glossaries, backups, and cloud sync. Applies only to plain-text bilingual webpage passages.

</details>

<details class="guide-details">
<summary>Floating ball and context-menu entries</summary>

### Page floating ball

**Settings → General → Page helpers → Full-page translation ball** is off by default. When enabled, it docks semi-transparently along the screen edge; click to translate/restore, drag to reposition, or hover/focus to expand tools and open the quick panel via the gear button.

Click **×** on the expanded toolbar to **Hide until reload**, **Hide on this site** (including subdomains), or **Hide on all sites**. In the userscript, **×** hides until reload.

### Context-menu translation

Right-click a webpage to translate the page, selected text to **Translate selected text**, or an image to translate it (enable desired entries in settings). Choose **Context menu only** under Selection translation activation to hide floating selection icons.

</details>

<details class="guide-details">
<summary>Automatic translation, page recognition, and paragraph tuning</summary>

### Automatic translation & languages

Configure per-site automatic translation or disable rules in [Site rules & reading area](/en/config/site-adaptation). Source languages can auto-detect or be fixed manually; supported language pairs vary by provider.

### Page recognition & compatibility

- Buttons, tabs, and form labels display translation-only to keep UI intact. Inputs, raw XML/RSS/SVG, standalone timestamps/counters, and GitHub code lines stay untouched.
- Standard embedded Hugging Face Space apps are supported in the browser extension.
- If navigation or menus are skipped, enable **Recognize all nodes** under **Advanced settings → Page recognition**, restore, and re-translate.

### Tune paragraph processing

Under **Advanced settings**:
- **Sidebar translation:** Include sidebars and navigation while keeping headers/footers untouched.
- **Minimum characters per paragraph:** Skip tiny fragments to reduce API calls.
- **Characters translated without scrolling:** Default `0`; increase to pre-translate the top of a page before scrolling.
- **Line breaks in long paragraphs:** Insert breaks after translated sentences.
- **Bilingual order:** Place original or translation first (applies immediately to existing translations).

</details>

## Related guides

- [Appearance & reading aids](/en/config/appearance)
- [Shortcuts & triggers](/en/guide/custom-hotkey)
- [Site rules & reading area](/en/config/site-adaptation)
- [Troubleshooting & FAQ](/en/guide/faq)
