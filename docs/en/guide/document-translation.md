# Document translation

Import PDF, EPUB, Word, PowerPoint, Excel, LaTeX, Markdown, spreadsheets, and subtitle files (17 formats) directly in your browser to read side-by-side translations, edit results, annotate PDFs, and export formatted bilingual or translated files.

<GuideVisual kind="document" en />

<DocDiagram kind="document-workflow" en />

## Supported formats & importing

Open **Document translation** from the extension menu, then drop a file or pick one from disk. No file handy? Expand **No file? Try a sample** (samples still require clicking **Start translation**).

| Category | Formats | Limits & notes |
| --- | --- | --- |
| **PDF papers & books** | `.pdf` | Up to **50 MB**; open online PDFs via **Open PDF reader** in the menu or paste a public PDF URL (download login-walled PDFs first) |
| **eBooks & Office** | `.epub`, `.docx`, `.pptx`, `.xlsx` | Up to **50 MB** for PPTX, **10 MB** for others; convert legacy `.doc`, `.ppt`, `.xls` files to `.docx`, `.pptx`, `.xlsx` first |
| **Academic & plain text** | `.tex`, `.html`, `.md`, `.txt` | Up to **10 MB**; supports UTF-8 and UTF-16 with BOM (exported as UTF-8) |
| **Structured tables** | `.json`, `.csv`, `.tsv` | Up to **10 MB**; choose specific columns to translate in CSV/TSV |
| **Subtitle files** | `.srt`, `.vtt`, `.ass`, `.ssa`, `.lrc` | Up to **10 MB**; preserves timestamps and styling tags |

You can also reopen **saved webpage articles** from Document History right where you left off, with existing translations and edits preserved; click **View original webpage** under the title to visit the source URL.

## Translating, reading & session control

1. Choose your **Translation provider** and **Target language** (plus model for AI providers) at the top; set **Source language & glossary** in the sidebar.
2. Check the preview and click **Start translation**. Paragraphs near your current reading position translate first and appear progressively.
3. Switch between **Original / Bilingual / Translation** anytime:
   - Use **Files** to switch documents and **Outline** to jump chapters.
   - Click **Focus reading** to hide surrounding chrome (`Esc` exits). Zoom previews via the toolbar, pinch, `Ctrl`+wheel, or `Ctrl/Cmd + / − / 0`.
   - **CSV / TSV columns:** Pick which columns to translate under **Columns to translate** (numbers, formulas, and URLs stay untouched; bilingual exports separate original and translation with a newline inside each cell).

### Pause, retry & switch providers

- **Pause & resume:** **Pause translation** keeps completed paragraphs and edits; **Resume** or **Retry** processes only remaining items.
- **Rate limits & switching providers:** Rate-limited providers wait and retry automatically. Pause before switching providers or models so existing results stay intact while remaining paragraphs use the new provider.
- **Changing language/glossary:** Prompts before **Translate again**, which replaces existing translations and edits—download first if you want to keep an earlier version.

## PDF dual reading modes & annotations {#what-are-the-limits-for-pdfs}

### Original layout vs. Reflow reading

| Capability | Original layout (default) | Reflow reading |
| --- | --- | --- |
| **Layout** | Side-by-side mirror preserving page positions, formulas, figures, author blocks, and numeric cells | Single-column flowing paragraphs (works on untranslated originals too) |
| **Best for** | Academic papers, figure-heavy pages, exact page-number alignment | Narrow windows, split screens, and long reading sessions |
| **Long text & themes** | Hover or click the book icon for **Full paragraph**; supports Paper / Mint / Dark / Custom colors & **Smart invert** | Customize font size, family, line height, spacing, and color themes while keeping figures full-color |
| **Search & selection** | Copy, search, and run selection translation directly on original pages | Full-text search and paragraph-level annotations |

::: info Browser built-in PDF viewer selection
In your browser’s built-in PDF viewer, you can also select text and right-click **Translate selected text** (up to 4,096 characters in a standalone popup window) when selection translation and its context menu are enabled.
:::

### Local annotations & exporting annotated PDFs

- Select text on a page (or paragraph in Reflow mode) to highlight, underline, or save a **Note** (up to **1,000 annotations** per document, stored with local history).
- Open **Annotations** in the toolbar to browse, jump, edit, or delete entries.
- Click **Export PDF** to save a copy with standard PDF annotations embedded (encrypted or damaged PDFs may not export).

### Hypothesis collaborative annotations

Choose **Annotations → Hypothesis collaborative annotations** inside FluentRead’s PDF reader to toggle the official sidebar:

- Sends only the PDF fingerprint, title, selected text, and annotations to Hypothesis—never uploads the PDF file, local paths, LAN URLs, or query-string download URLs, and FluentRead never handles your Hypothesis login token.
- Temporarily pauses while translating and resumes afterward; provides official proxy and local-PDF fallback links if connection fails.

## Scanned PDF OCR & text correction

Scanned PDFs or mixed scanned pages are handled automatically:

1. Verify the source language and click **Start translation**—FluentRead runs OCR from the current page onward (downloading missing OCR packs as needed) and then translates.
2. Progress is saved page by page; after OCR finishes, you can select and copy recognized text directly over the scanned page.
3. If OCR misreads text, open **Correct recognized text** in document settings to edit line by line (only modified paragraphs invalidate their translations), or choose **Re-recognize current page**.

<details class="guide-details">
<summary>Scanned PDF verification & special layout handling</summary>

- **Superscripts, subscripts & numbers:** Numeric indices in scanned papers are zoomed and re-verified locally; unverified regions show dashed **Check original** markers. Low-confidence digits with solid glyph evidence keep their reading with a verification mark.
- **Low-confidence CJK & bullet lists:** Low-confidence Chinese characters are double-checked at two downscales and auto-corrected only when both high-confidence passes agree; bullet symbols are verified by shape and indentation.
- **Figures & tables:** Verified diagrams stay intact with translated captions; bordered tables and well-aligned borderless numeric tables are structured cell-by-cell while leaving pure numbers untouched.
- **Native PDF details:** Double-stroked bold/shadow text counts once; text above formulas separates cleanly from tall integral/summation signs; text cards stay within their boxes.

</details>

## Editing & downloading results {#edit-and-download}

1. Click **Edit translations** to search passages or filter untranslated segments and edit directly—edits are written into downloads.
2. Click **Download**, select **Bilingual** or **Translation only**, and click the primary download button (**Download original** saves the source anytime).
3. Partial documents require confirming **Download current results** (untranslated segments keep their originals). Downloads can be canceled cleanly without losing edits.

| Format | Export preservation |
| --- | --- |
| **PDF** | Choose **Original layout** (side-by-side pages, overflow continuation pages with jump-back footers, translated bookmarks) or **Reflow layout** (fixed-size flowing pages; caches a ~5 MB open-license font on first use) |
| **EPUB** | Preserves chapters, images, links, and styles, and syncs translated/edited chapter titles into the reader TOC |
| **DOCX (Word)** | Preserves links, bold/italic styles, and tables in normal paragraphs; keep `<g1>…</g1>` format tags when editing |
| **PPTX (PowerPoint)** | Extracts slide text and speaker notes in numeric order while preserving shapes, tables, images, animations, and run styles; appends bilingual paragraphs or replaces text in place |
| **XLSX (Excel)** | Reads multiple worksheets in workbook order (shared and inline strings), strictly preserving formulas, numbers, dates, and styles; bilingual exports separate lines inside each cell |
| **LaTeX (`.tex`)** | Preserves preamble, comments, math, and `verbatim`/`lstlisting`/`minted`/`tikzpicture` environments with numbered inline-command markers so exported source stays compilable |
| **Markdown / HTML** | Preserves GFM tables, links, and code blocks; merges soft line wraps before translating |
| **Subtitles / CSV / JSON** | Keeps cue numbers and timestamps; writes back chosen CSV/TSV columns; preserves JSON structure (up to 1,000 levels deep) |

::: tip Local history & persistence
Files, translations, and edits stay in browser IndexedDB (up to 20 documents / 80 MiB total original size) so you can resume from **Recent translations**. Cross-tab edits never silently overwrite newer work; download important documents before clearing browser data.
:::

<details class="guide-details">
<summary>PDF overflow pages, cross-page context & recovery</summary>

- In Original layout exports, translations that exceed the original box are placed on continuation pages immediately after the source page, with jump-back footers and full text searchability.
- Existing bookmarks or detected headings update automatically to match translated titles and new page numbers.
- If a PDF is re-parsed, unmatched manual edits are preserved under **Edit translations → Preserved previous edits**; adjacent pages can be compared via **Cross-page context**.

</details>

<details class="guide-details">
<summary>Multi-segment batching, subtitle neighbor context & AI document context</summary>

- **Multi-segment translation** is enabled by default to reduce small requests and can be toggled per document.
- **Subtitle neighbor context:** Prompt-capable AI providers translating SRT/VTT/ASS automatically see up to 6 cues before and after (capped at 1,200 chars) for natural phrasing while preserving per-cue timestamps.
- **AI document context:** When **AI refined translation** is enabled, each paragraph references chapter definitions, nearby originals, and completed translations (manual edits override machine context; glossaries take highest priority).

</details>

<details class="guide-details">
<summary>Save as learning material, batch queue & Obsidian integration</summary>

### Save materials & resume reading {#save-materials-and-keep-reading}

Click **Add to learning materials** (or **Update reading position**) to organize saved quotes, notes, and location in [Learning Center](/en/guide/vocabulary-book). Re-selecting the same file restores your position even after local cleanup.

### Batch translation {#batch-translation}

Drop multiple files or use **Files → Add files**, then click **Translate remaining files** to process sequentially. Single failures never halt the queue; export completed items together via **Download completed files (ZIP)**.

### Translate inside Obsidian {#translate-in-obsidian}

Follow the [experimental Obsidian desktop plugin](https://github.com/FluentRead/FluentRead/tree/main/integrations/obsidian) guide to translate Markdown and text-layer PDFs into adjacent bilingual Markdown notes (currently uses Microsoft Translator without overwriting originals).

</details>

## Are my files uploaded?

Files are parsed and exported locally in your browser; only the text to be translated is sent to your chosen provider. See [Privacy policy](/en/guide/privacy).

## Related guides

- [Glossaries (with paper term extraction)](/en/guide/glossary)
- [Translation providers](/en/config/translation-engines)
- [Troubleshooting & FAQ](/en/guide/faq)
