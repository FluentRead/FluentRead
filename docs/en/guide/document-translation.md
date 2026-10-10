# Document translation

Import a document to read alongside its translation, edit passages as needed and download the result.

<GuideVisual kind="document" en />

## Open your file

Choose **Document translation** in the extension menu and drop a file onto the page, or use the file picker.

For an online PDF such as [Attention Is All You Need](https://arxiv.org/pdf/1706.03762), open the extension menu and choose **Open PDF reader** or **Document translation**. You can also paste a direct PDF link on the document page. Browser PDF viewers restrict content scripts, so FluentRead opens the original file in its own reader without changing it. If a download requires a login and cannot be opened, download the file and import it.

Supported formats include PDF, ePub, Word DOCX, HTML, TXT, Markdown, JSON, and SRT, VTT, ASS, SSA, and LRC subtitle files. Convert older `.doc` files to `.docx` first.

Expand **No file yet? Try a sample** to open a local article, subtitle, or language-file sample. Importing a sample does not start translation automatically. Confirm settings, then use the same reading, proofreading, and download flow as with your own files.

## Translate and read

1. Choose the translation service and target language in the toolbar, and a model when using an AI service. Use the sidebar settings for the source language and glossary.
2. Check the preview, then start translation.
3. Switch between original, bilingual, and translated views.

In narrow windows, reading controls and translation actions use separate rows. **Translation settings** opens the service, target language, and model choices in a dialog; reading, proofreading, translation or pause, and download remain available on the page.

You do not wait for the whole file: each finished batch appears as soon as it returns, starting from where you are reading (the current PDF page, ePub chapter, Word part, or subtitle/JSON page). **Translate multiple passages together** is enabled for each document. Supported machine and AI services receive several passages per request; identical source passages are translated once. Disable this option in **Translation settings** for the current document. It does not change web translation or the global multiple-passage setting.

The sidebar lists your files and, for PDFs and for Markdown, HTML, ePub, and Word documents that have headings, an outline you can show in the original or the translation and click to jump; an ePub lists every chapter there, with the current chapter’s headings beneath it. Markdown, plain text, and Word show each paragraph beside its translation on wide windows and below it on narrow ones; tables in Word stay tables, with each translation inside its own cell.

Every format supports trackpad pinch to zoom over the document, or Ctrl with the mouse wheel. Two-finger panning scrolls normally. Click the document, then use **Ctrl/Cmd +**, **Ctrl/Cmd −**, or **Ctrl/Cmd 0** to zoom in, zoom out, or reset; the toolbar offers the same controls. Non-PDF documents zoom from 50% to 300%, and clicking the percentage restores 100%. PDF reset fits the width, and zoom in the original layout aims to keep the page position under your pointer. Zoom changes the reading preview; proofreading inputs and downloaded files keep their usual layout.

URLs, email addresses, code-style names such as `FluentRead`, and compound identifiers such as `GNMT+RL` are kept as written in document text. Free services can use different translations for technical terms; choose a suitable glossary and review key passages in the proofreading view.

In HTML, ePub, and Markdown, a sentence that contains links, bold, italics, or inline code is translated as one sentence: links and emphasis stay on the matching words, and in Markdown the link text is translated while link targets, inline code, and URLs are kept as they are. If a service does not keep those markers, you still get the complete sentence, with code and URLs appended at its end.

Markdown keeps heading levels, list numbers, container directives, and standalone HTML/component tags locally. The free service pool checks inline formatting markers and tries another route if they are changed or lost, so a successful translation retains emphasis, links, and code positions in the download.

Pause a long job if needed. Completed passages remain available after a pause or request failure; continuing processes the remainder. Changing languages, services, models, or glossary settings requires a fresh translation, with a prompt first.

Once translation finishes, the workspace focuses on reading, proofreading, and downloading. Open **Adjust settings** to retranslate, configure service connections, or replace files. Confirmation prompts protect results you have not downloaded.

## Edit and download

Open the proofreading view to search for a sentence or filter untranslated passages. Edit translations directly; your changes apply to the preview and download.

Download starts with your current bilingual or translated reading mode. Reading the original keeps the previous download choice. You can change the output in the dialog and check its filename and content preview. Binary formats show a text excerpt and retain their original format when downloaded.

Translation-only subtitle output replaces the cue text while preserving numbering, timing, and formatting tags. Bilingual output keeps both texts in each cue. Downloads include your corrections. Confirm partial downloads explicitly; untranslated or cleared passages retain the source text. Changing settings does not retranslate existing results, so downloads still use the translations currently kept on the page.

::: tip Refreshing keeps your progress
Documents, translations and edits are stored in this browser: a refresh returns to the document you were reading, and **Recent translations** on the start page restores earlier ones. Download a file when you need to keep or share it.
:::

## PDF limits

Online and imported PDFs share the same reader. Select or copy text on the original page; translation follows your selection settings, including the icon, direct card, and keyboard shortcut. Selection uses your selection translation service, while translating the whole document uses the document translation service. Read continuously, jump to a page, or adjust zoom without translating the entire file first.

The reader prioritizes visible pages and retains canvases and text layers for at most five pages. Pages outside that window are released and rendered again when needed. Zoom keeps your current page position. Import shows downloaded bytes or parsed pages and supports cancellation and retry.

Papers, reports, slide decks exported to PDF, notes, and word-processor exports are each segmented by their own layout: text inside slide content frames and title bands is translated, and body text set at 1.5 to 2 line spacing still translates as whole paragraphs. A PDF may be up to 50 MB; other formats up to 10 MB.

Scanned PDFs without a text layer can be translated too: after you start translation, text is recognized page by page from the current page with visible progress, then translated in the same layout; you can pause at any time. Recognition uses the image-translation language packs, which download automatically when missing, so choose the correct source language first. Text on scanned pages cannot be selected. Scanned pages inside an otherwise typed PDF and rotated scanned pages are recognized too and laid out in their upright orientation; blank pages are not.

PDFs default to the **Original layout**, side by side: each translated paragraph is placed back at the position and size of its source paragraph and appears as it arrives, while waiting paragraphs show the loading style chosen in your interface settings. Formulas, figures and numeric table cells stay as they are; table headers, text cells and captions are translated. Hover a long translation to expand it; hovering also highlights the matching source paragraph (switch it off under **Translation style**). Translation starts from the page you are reading, retries automatically for up to two minutes when a service is briefly unavailable, and reports the reason if it still fails. Switch to **Reflowed text** for complete paragraphs at a fixed size. The toolbar also offers **Search** across source and translation, an **Outline** in the sidebar, and **Focus reading**.

PDF downloads keep the original layout. Each bilingual output page has the original on the left and the translation of that same source page on the right, with the original page count and order. Translation-only output keeps the matching translated pages. No extra layout previews or reflowed pages are inserted. Formulas and figures stay in place. Longer passages show the beginning that fits, with the full text available in a PDF comment at the matching location. Translated pages remain images; copy text from the reader or open the comment in a PDF viewer. The download dialog shows the layout, page count, and progress, followed by the saving stage. **Cancel export** keeps your translations and edits for retry. The reader retains nearby pages, while export encodes and releases one canvas at a time.

ePub downloads retain chapter order, links, images and original styles; bilingual XHTML chapters keep their standard XML structure. ePub, DOCX and batch ZIP downloads show packaging progress and allow cancellation without losing translations or edits. Large JSON download previews show text excerpts while the exported file keeps its complete structure. In plain text, a paragraph that was wrapped at a fixed width is translated as one paragraph, while headings, lists, and lines that are sentences of their own stay separate. In JSON, strings meant for programs (version numbers, URLs, colour values, and identifiers containing digits) are left as they are and not sent for translation. Text download previews only encode the excerpt needed by the dialog. PDF translation appears as it progresses; other reading previews refresh after translation pauses or finishes to reduce repeated work on long documents.

## Does the file leave my computer?

The browser parses the file locally. Text to translate is sent to your selected service. Cloud translation therefore sends the relevant text outside your computer. See [Data & privacy](/en/guide/privacy).

<details class="guide-details">
<summary>Translate in Obsidian</summary>

## Translate in Obsidian

FluentRead also has an [experimental Obsidian desktop plugin](https://github.com/FluentRead/FluentRead/tree/main/integrations/obsidian). Follow the build and install instructions in its directory, then translate Markdown notes or text-based PDFs from the command palette or file context menu. The plugin saves and opens a sibling bilingual Markdown note without overwriting the source. It currently uses Microsoft Translator, which receives the text to translate. PDF output is grouped by page rather than preserving the original PDF layout.

</details>

<details class="guide-details">
<summary>Batch translation</summary>

## Batch translation

Select or drop multiple files, or use **Add files** in the sidebar's **Files** tab to keep existing files and translations; a newly added file becomes the current document. Confirm the service and target language, then use the batch action to translate the remaining files in order.

Each file has its own progress. An import or translation failure does not stop other files. **Pause all** preserves completed segments; starting again resumes the remaining work. If settings change, confirm restarting each partially translated file before continuing the batch, so reviewed text is not silently replaced.

When the queue stops, select a file to read, review or download it individually. Choose bilingual or translation-only output and click **Download completed files (ZIP)** to bundle completed documents. Incomplete files are excluded, and files with the same name use separate numbered folders. Switching files preserves your work; removing undownloaded translations asks for confirmation.

Files and translations are stored in this browser and can be restored from **Recent translations**; download what you need to take with you.

</details>

## Related guides

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
