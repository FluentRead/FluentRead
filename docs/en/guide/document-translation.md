# Document translation

Import a file, read it alongside its translation, edit passages, and download the result.

<GuideVisual kind="document" en />

## Open your file

Choose **Document translation** in the extension menu, then drop a file onto the page or use the file picker. Without a file, expand **No file yet? Try a sample**. Samples also wait for you to start translation.

For an online PDF, choose **Open PDF reader** from the extension menu or paste its direct link on the document start page. FluentRead opens the original in its own reader. If a link requires a login and cannot be opened, download the file first and import it.

Supported formats are PDF, ePub, Word DOCX, HTML, TXT, Markdown, JSON, and SRT, VTT, ASS, SSA, or LRC subtitles. The limit is **50 MB for a PDF** and **10 MB for other formats**. Convert older `.doc` files to `.docx` first.

## Translate and read

1. Choose the **translation service**, **target language**, and a model for AI services in the toolbar. Set the source language and glossary in the sidebar; narrow windows use **Translation settings**.
2. Check the file, then start translation.
3. Switch between original, bilingual, and translated views. Translation starts near your current reading position and completed passages appear as they arrive.

Use **Files** in the sidebar to switch documents and **Outline** to jump to chapters. **Focus reading** hides surrounding controls; Esc exits. Zoom with the toolbar, a trackpad pinch, or Ctrl with the mouse wheel. After clicking the document, **Ctrl/Cmd +, −, and 0** also work. Zoom affects only the reading preview.

### Pause, retry, or change services

**Pause translation** preserves completed translations and edits. Continue, or choose **Retry** after a failure, to process unfinished passages.

Temporary outages and rate limits show a reason and retry automatically; you can pause while waiting. To change a service or model, pause, make the change, and continue. Changing the active service or model from another page also pauses the old task. Existing results remain and the new service handles the remainder.

Changing languages, glossary settings, or some connection parameters requires a fresh translation. Confirming **Retranslate** replaces existing translations and manual edits, so download the current version first if needed. Expand **Details** to inspect an error.

## Edit and download

1. Open proofreading, search for a sentence or filter untranslated passages, and edit the translation directly.
2. Open **Download**, choose **Bilingual** or **Translation only**, then use the download button below. Your edits are included.

The selected version is independent of the reading view. Partial downloads require confirmation. Passages without a translation, including cleared translations, retain their source text. Changing settings alone does not retranslate the file; downloads use the results currently kept.

The panel opens beside the toolbar. PDF versions include a small layout illustration. Expand **PDF layout** to choose **Original** or **Reflow** without changing the reading view. If generation fails, your translation and edits are kept. Use **Retry download**, or expand **Technical details** to inspect the cause.

**Download original** saves the opened source file without translating it first. You can cancel and retry ePub, DOCX, PDF, or batch ZIP generation without losing translations or edits.

::: tip Continue after a refresh
Documents, translations, and edits are stored in this browser. Continue after refreshing or restore an earlier file from **Recent translations**. Clearing browser data can remove them; download files you want to keep or share.
:::

## PDF limits

PDFs default to **Original layout**: bilingual pages appear side by side, translated paragraphs follow the source positions, and formulas, figures, and numeric table cells keep their original appearance. Hover over a long passage or use the book button beside it to read the full paragraph. Choose **Reflowed text** for complete paragraphs in a reading layout. The toolbar offers search across both texts and translation styling.

Proofreading, full-passage comparisons, outline titles, and search terms each follow their own text direction, while the source and translation columns keep their order.

Scanned PDFs and scanned pages within text PDFs are supported. Starting translation first recognizes text from the current page, then translates it. Missing recognition packs download automatically, so check the source language first. Scanned text cannot be selected directly. Recognition, formulas, and technical terms can still be wrong; review important passages.

You can select, copy, and translate original-page text. Selection uses your separate selection translation service; the whole document uses the document service. In the browser's own PDF viewer, select text and choose **Translate selected text** from the context menu to open a separate result window. Enable selection translation and its context-menu entry first. The limit is 4096 characters per selection.

<details class="guide-details">
<summary>PDF exports, long passages, and retained edits</summary>

Original-layout downloads keep the source-page order. Bilingual output places each source page beside its translation; translation-only output keeps translated pages. Long passages retain a full PDF comment and continue on extra text pages after their matching source page, so the exported file can have more pages. Translated text can be searched, selected, and copied.

Downloading one document in **Reflowed text** uses fixed-size text with automatic page breaks. Bilingual output follows each source page with its translation. Figures and formulas stay together where possible; use Original layout when exact original glyphs matter. The first reflowed export prepares a font of about 5 MB online, then reuses it locally. Font requests contain no document text, translations, or credentials. Uncommon glyphs may depend on local fonts. Batch exports use Original layout.

Identical text painted again in place for bold or shadow effects is counted once in the analyzed source and translation input. Adjacent repeated words, different text, and partial overlaps are retained. Original-page pixels are unchanged.

Explanatory text above a formula is separated from raised integral and summation symbols so it is not skipped as part of the formula. Table boundaries and original-page glyphs remain unchanged.

Letter-spaced section names such as Abstract and References are recognized with supporting body text below. Their original spacing is retained; the source is not rewritten as an unspaced word.

After a PDF is parsed again, edits are restored only when the source text and position can be identified safely. Other edits remain available to read and copy under retained revisions in proofreading. Clearly connected page fragments offer an optional cross-page context view; source passages and edits are not merged automatically.

</details>

<details class="guide-details">
<summary>Other formats, terminology, and AI context references</summary>

Markdown, HTML, and ePub aim to retain links, emphasis, and inline code. URLs, email addresses, code blocks, and program identifiers remain unchanged. If formatting cannot be preserved, retry or change services. JSON keeps its structure and non-text values; nesting beyond 1000 levels is unsupported. Word tables remain tables, and ePub downloads retain chapters, images, links, and styles.

Subtitle exports retain numbering, timing, and formatting tags. Translation-only output replaces the cue text; bilingual output keeps both texts in each cue. Fixed-width wrapped text is joined into paragraphs, while headings and lists stay separate where possible.

**Translate multiple passages together** is enabled by default to reduce small requests. Disable it in the current document's settings without changing webpage settings. Format protection does not guarantee accurate or complete translation. Use a glossary for consistent terminology and review key passages.

### Context references

With **AI enhanced translation** enabled for an AI service that supports general prompts, translation can use current-chapter definitions, nearby source text, and completed translations. Edits confirmed in the current reading session take priority over machine references; your glossary has the highest priority.

This mode processes passages one by one and can be slower. References cover a limited range and cannot guarantee that every ambiguity is resolved. Maintaining context makes no extra model calls and does not persist across documents.

</details>

<details class="guide-details">
<summary>Save a material and resume reading</summary>

## Save a material and resume reading

Choose **Add to learning materials** to keep the document with your saved expressions, questions, and notes. For an existing material, update the reading position. Continuing from the Learning Center returns to the saved passage. Materials and positions stay in this browser.

If the local source has been cleared, select the same file again. A different file with the same name does not overwrite the old material. If the reader cannot identify the passage, it keeps the old location and asks you to save a new one. Older materials may restore only a page or chapter, so check the position. Scrolling manually stops automatic positioning.

</details>

<details class="guide-details">
<summary>Batch translation</summary>

## Batch translation

Drop several files together or use **Files → Add files** in the sidebar. Confirm the service and language, then translate the remaining files in order. One file's failure does not stop the others; **Pause all** preserves completed work.

Once the queue stops, read, edit, or download individual files. **Download completed files (ZIP)** includes completed documents only, with separate numbered folders for duplicate names. Changed settings require a separate restart confirmation for each partially translated file. Removing undownloaded results also asks for confirmation.

</details>

<details class="guide-details">
<summary>Translate in Obsidian</summary>

## Translate in Obsidian

Follow the directory instructions to build and install the [experimental Obsidian desktop plugin](https://github.com/FluentRead/FluentRead/tree/main/integrations/obsidian). Translate Markdown notes or text-based PDFs from the command palette or file context menu. It saves a sibling bilingual Markdown note without overwriting the source. This plugin currently sends text to Microsoft Translator; PDF output does not retain the original layout.

</details>

## Does the file leave my computer?

The browser parses files locally. Text to translate goes to your selected service. With a cloud service, the relevant text leaves your device. See [Data & privacy](/en/guide/privacy).

## Related guides

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
