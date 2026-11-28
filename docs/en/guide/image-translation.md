# Image & manga translation

Recognize text in webpage images and comics locally in your browser, cleanly restore the background, and render translations directly onto the image—plus inspect or copy full text in a dedicated side panel.

<GuideVisual kind="image" en />

<DocDiagram kind="image-pipeline" en />

## Translate a single image

1. Open **Settings → Image & manga translation**, enable **Webpage image translation**, and confirm source language, target language, and provider.
2. Hover over an image for ~0.6 seconds and click the bottom-left translate icon (or right-click and choose **Translate image**).
3. On first use, prepare local OCR assets when prompted. Afterward, toggle **Original / Translated** anytime, or open **Text → Compare original** to read and copy full results.

### Helpful interactions

- **Reuse in lightboxes:** Clicking a translated image to open a full-size viewer reuses the existing translated image without re-running OCR or translation.
- **Cancel & compare:** Canceling keeps already-downloaded models. For dense text or tiny images, open the text panel (`Esc` closes it cleanly).
- **Animated images:** Animated images generate a static translated frame; switch back to **Original** anytime to resume playback.

## Continuous manga translation

1. Enable **Continuous manga translation** in the same settings page and open a supported reader such as **MANGA Plus**, **Pixiv**, or a custom self-hosted local/LAN reader rule (including explicit ports on `localhost` or private LAN hosts).
2. Click the manga button on the page; confirm **Prepare resources & start** if models are missing (choosing Later starts no download).
3. Visible pages translate first, and scrolling automatically continues through the chapter:
   - **Live progress:** Both the manga launcher and floating ball display live translated page counts, prefetch status, and error counts.
   - **Quick original comparison:** Press and hold **Hold to compare original** beside the launcher to peek at the original without pausing prefetch, or hover the corner of a translated page to toggle **Original image** / **Translate again**. Click the manga button again to pause the chapter and show all originals.
   - **Prefetch control:** Prefetches the next **3 loaded pages** by default (configurable from **0–5**; `0` translates visible pages only).

### Manga text panel

Expand **View manga text** beside the manga launcher to read, search, and copy completed text for visible pages or long-image segments:

- Automatically opens when only a single visible candidate exists, with in-panel search, previous/next page switching, and per-line copy.
- Reads only existing snapshots and never triggers fresh OCR or translation.
- When a translation is held back to protect original brands, numbers, or artwork, an **Unpainted translations** filter badge appears so you can jump directly to those entries; **Copy current** copies the filtered view while **Copy all** copies the entire selected page.

::: tip Supported readers & area manga mode
Search **Supported websites** in settings to check each reader’s mode: some support continuous translation while others use **Area manga translation** (drag to select visible regions). On unlisted sites, use single-image or [Area translation](/en/guide/area-translation).
:::

## OCR engines & local backend

| Component / Option | Size & Role | When it is used |
| --- | --- | --- |
| **PaddleOCR (Default standard)** | ~**30 MB**, shared by images & manga | Everyday horizontal text, comic speech bubbles, and colored text |
| **Tesseract (Lightweight)** | Per-language packs on demand | Automatically used for single images when source is set to **Russian, Korean, Arabic, or Hebrew**; also supports vertical Japanese |
| **LaMa Inpainting** | ~**197 MB** (manga complex backgrounds) | Cleanly removes text over screentones, gradients, and illustrations; not loaded for single-image mode |
| **Local processing backend** | **Auto** (WebGPU / WASM) or **CPU (WASM)** | Switch to **CPU (WASM)** if GPU inference causes browser stutter; check active backend under **OCR resources → Runtime info** |

## Are images uploaded?

**No.** Text recognition (OCR) and background inpainting run entirely on your device. Only the extracted text is sent to your chosen translation provider; image pixels never accompany text translation requests. Internet access is needed only for initial model downloads and online translation providers. See [Privacy policy](/en/guide/privacy).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No icon on an image | Avatars, icons, emojis, and small thumbnails are skipped; try right-click translation, open the full-size image, or use [Area translation](/en/guide/area-translation) |
| Inaccurate OCR | Verify the source language and use a higher-resolution source; check names, numbers, and stylized fonts in the text panel |
| Single manga page failed | Failed pages keep their original image while others continue; hover to click **Translate again** or toggle off and back on |
| Local model error | Use **Adjust local model** or **Switch image provider**—FluentRead never silently reroutes local tasks to cloud providers |
| No response after extension update | Refresh the webpage and retry |

<details class="guide-details">
<summary>Typography, protection, inpainting & OCR optimization details</summary>

### Original protection & safe fallback painting

- Recognized brand names, text already in the target language, standalone times/dates/currencies/percentages, and transparent manga cutouts are protected from being overwritten; unpaintable translations remain fully readable in the text panel.
- When horizontal manga bubbles conflict with protected originals, FluentRead can paint the complete translation into verified clean white space inside the same closed bubble without re-running OCR or translation.

### Fonts, line wrapping & layout balance

- Uses device fonts matched to the target language’s glyph metrics, with a bundled fallback font covering 305 extended CJK ideographs and 485 variant mappings (including JIS X 0213) without extra downloads.
- Prevents orphaned punctuation, preserves grapheme clusters and emojis, balances short final lines, respects RTL paragraph direction for Arabic/Hebrew, groups Japanese furigana with its base text, follows slight tilt angles on photos, and preserves 90° rotated spine/sidebar Latin labels when verified.

### Background restoration & inpainting

- Solid and smooth-gradient backgrounds restore original backdrop and text colors directly to minimize inpainting color shift; lined paper, diagonal edges, and small ornaments are preserved when supported by pixel evidence.
- Optional text segmentation resources can clean strokes extending beyond tight OCR boxes on solid backgrounds. Complex textures or semi-transparent overlays may still leave traces—toggle back to Original anytime.

### Contrast, spacing & context

- Automatically boosts contrast on colored/dark-background text, restores missing spaces in tightly cropped English labels (e.g., `ROUTEC4` → `ROUTE C4`), and avoids mistaking highlights or textures for text.
- With **AI context** enabled on a prompt-capable AI provider, each region sees up to two preceding and two following text blocks from the same image (no extra summary call); Google native batching shares context across up to four aligned sentences.
- Transformed CSS images (rotated, scaled, mirrored) inherit native webpage transforms; unsupported clipping/fixed-rotated layouts keep the original image and direct you to the text panel.

</details>

<details class="guide-details">
<summary>Manga resources, offline import & caching</summary>

### Manga resources

Manage downloads, clear storage, or import verified model files offline under **Image & manga translation → OCR resources**. Interrupted downloads resume missing files automatically. Once models are cached, OCR and inpainting run offline (text translation still depends on your chosen provider). Continuous manga uses browser-extension local models and is limited in userscripts.

</details>

<details class="guide-details">
<summary>Source languages & Tesseract language packs</summary>

### Source language settings

Source and target languages are shared with webpage and area translation; single images and manga share the image provider. Tesseract **Auto-detect** prepares Simplified Chinese, Traditional Chinese, English, and Japanese packs by default; choose explicit languages for other scripts. Downloads continue in the background if you leave settings.

</details>

<details class="guide-details">
<summary>Cross-origin & restricted images</summary>

### Cross-origin images

Public HTTPS images are handled automatically; when canvas reads are blocked by CORS, FluentRead fetches credential-free image bytes (sending only the required origin header for Pixiv, never login cookies). Login-walled, private-network, or >**16 MiB** images show the specific reason—use [Area translation](/en/guide/area-translation) instead.

</details>

## Related guides

- [Area translation](/en/guide/area-translation)
- [Translation providers](/en/config/translation-engines)
- [Troubleshooting & FAQ](/en/guide/faq)
