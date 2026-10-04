# Document translation

Import a document to read alongside its translation, edit passages as needed and download the result.

<GuideVisual kind="document" en />

## Open your file

Choose **Document translation** in the extension menu and drop a file onto the page, or use the file picker.

Supported formats include PDF, ePub, Word DOCX, HTML, TXT, Markdown, JSON, and SRT, VTT, ASS, SSA, and LRC subtitle files. Convert older `.doc` files to `.docx` first.

Expand **No file yet? Try a sample** to open a local article, subtitle, or language-file sample. Importing a sample does not start translation automatically. Confirm settings, then use the same reading, proofreading, and download flow as with your own files.

## Translate and read

1. Check the language and service above the document. Use **Adjust settings** to choose languages, service, and AI model. Settings open on demand to keep the reading area clear.
2. Check the preview, then start translation.
3. Switch between original, bilingual, and translated views.

Pause a long job if needed. Completed passages remain available after a pause or request failure; continuing processes the remainder. Changing languages, services, models, or glossary settings requires a fresh translation, with a prompt first.

Once translation finishes, the workspace focuses on reading, proofreading, and downloading. Open **Adjust settings** to retranslate, configure service connections, or replace files. Confirmation prompts protect results you have not downloaded.

## Edit and download

Open the proofreading view to search for a sentence or filter untranslated passages. Edit translations directly; your changes apply to the preview and download.

Download starts with your current bilingual or translated reading mode. Reading the original keeps the previous download choice. You can change the output in the dialog and check its filename and content preview. Binary formats show a text excerpt and retain their original format when downloaded.

Translation-only subtitle output replaces the cue text while preserving numbering, timing, and formatting tags. Bilingual output keeps both texts in each cue. Downloads include your corrections. Confirm partial downloads explicitly; untranslated or cleared passages retain the source text. Changing settings does not retranslate existing results, so downloads still use the translations currently kept on the page.

::: tip Download before leaving
Results stay in the current page. Download what you want to keep before refreshing, closing, or opening another document.
:::

## PDF limits

Use a PDF with selectable text. Scanned PDFs are not directly recognized; convert them to a text document first, or use image translation for a few pages.

Translated PDF pages are rendered as images for visual reading. Copying text from those translated pages is not currently supported. Check complex tables, formulas, and unusual fonts carefully.

PDF downloads show the number of completed pages, followed by a saving stage. Longer documents take more time. Choose **Cancel export** to stop generation; translations and edits are kept so you can download again. Very large or tall pages use a lower image resolution to limit memory use while preserving the original page dimensions.

ePub, DOCX and batch ZIP downloads show packaging progress and allow cancellation without losing translations or edits. Large JSON download previews show text excerpts while the exported file keeps its complete structure. Text download previews only encode the excerpt needed by the dialog. Reading previews refresh after translation pauses or finishes to reduce repeated work on long documents.

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

Select or drop multiple files, or use **Add files** at the top of the page to keep existing files and translations. Collapse the multi-file queue for more reading space. Confirm the languages, service and model, then choose **Translate remaining files** to process unfinished documents in order.

Each file has its own progress. An import or translation failure does not stop other files. **Pause all** preserves completed segments; starting again resumes the remaining work. If settings change, confirm restarting each partially translated file before continuing the batch, so reviewed text is not silently replaced.

When the queue stops, select a file to read, review or download it individually. Choose bilingual or translation-only output and click **Download completed files (ZIP)** to bundle completed documents. Incomplete files are excluded, and files with the same name use separate numbered folders. Switching files preserves your work; removing undownloaded translations asks for confirmation.

Files and translations stay in this page only. Download your results before refreshing or closing it.

</details>

## Related guides

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
