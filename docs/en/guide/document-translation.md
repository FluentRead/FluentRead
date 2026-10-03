# Document translation

Read a file beside its translation. Edit a passage when needed, then download a copy to keep.

## Open your file

Choose **Document translation** in the extension menu and drop a file onto the page, or use the file picker.

Supported formats include PDF, ePub, Word DOCX, HTML, TXT, Markdown, JSON, and SRT, VTT, ASS, SSA, and LRC subtitle files. Convert older `.doc` files to `.docx` first.

## Translate in Obsidian

FluentRead also has an [experimental Obsidian desktop plugin](https://github.com/FluentRead/FluentRead/tree/main/integrations/obsidian). Follow the build and install instructions in its directory, then translate Markdown notes or text-based PDFs from the command palette or file context menu. The plugin saves and opens a sibling bilingual Markdown note without overwriting the source. It currently uses Microsoft Translator, which receives the text to translate. PDF output is grouped by page rather than preserving the original PDF layout.

## Batch translation

Select or drop multiple files, or use **Add files** in the file queue. Confirm the languages, service and model, then choose **Translate remaining files** to process unfinished documents in order.

Each file has its own progress. An import or translation failure does not stop other files. **Pause all** preserves completed segments; starting again resumes the remaining work. If settings change, confirm restarting each partially translated file before continuing the batch, so reviewed text is not silently replaced.

When the queue stops, select a file to read, review or download it individually. Choose bilingual or translation-only output and click **Download completed files (ZIP)** to bundle completed documents. Incomplete files are excluded, and files with the same name use separate numbered folders. Switching files preserves your work; removing undownloaded translations asks for confirmation.

Files and translations stay in this page only. Download your results before refreshing or closing it.

## Translate and read

1. Choose the source language, target language, and service on the left. For AI services, confirm the model too.
2. Check the preview, then start translation.
3. Switch between original, bilingual, and translated views.

Pause a long job if needed. Completed passages remain available after a pause or request failure; continuing processes the remainder. Changing languages, services, models, or glossary settings requires a fresh translation, with a prompt first.


<figure class="doc-figure"><a href="/screenshots/en/document.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/en/document.webp" width="2560" height="1600" alt="Document workspace with automatic source detection and complete bilingual paragraphs" loading="lazy" /></a></figure>

## Edit and download

Open the proofreading view to search for a sentence or filter untranslated passages. Edit translations directly; your changes apply to the preview and download.

Choose download, then bilingual or translation-only output. The file keeps its original format. You can confirm a partial download before completion; untranslated passages retain their original text.

::: tip Download before leaving
Results stay in the current page. Download what you want to keep before refreshing, closing, or opening another document.
:::

## PDF limits

Use a PDF with selectable text. Scanned PDFs are not directly recognized; convert them to a text document first, or use image translation for a few pages.

Translated PDF pages are rendered as images for visual reading. Copying text from those translated pages is not currently supported. Check complex tables, formulas, and unusual fonts carefully.

## Does the file leave my computer?

The browser parses the file locally. Text to translate is sent to your selected service. Cloud translation therefore sends the relevant text outside your computer. See [Data & privacy](/en/guide/privacy).

## Next steps

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
