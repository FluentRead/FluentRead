# Image translation

In **Settings → Image / Manga Translation**, **Local processing backend** defaults to **Auto**. If image processing stalls the browser, choose **CPU (WASM)**. Subsequent PaddleOCR, LaMa and imported optional text segmentation sessions skip WebGPU from their first initialization and use single-threaded WASM with CPU timeouts. Switching does not download models. An active inference finishes or times out before the Worker switches at a request boundary; Cancel immediately ends the page’s wait. This setting does not change Tesseract recognition.

**Recognition resources → Runtime details** shows the current stage and the providers configured for the latest successfully initialized session. `wasm` means CPU only; `webgpu / wasm` allows ONNX Runtime to assign operators to either provider and does not prove that every operator ran on the GPU. Automatic CPU fallback is shown separately.

Read translations over a webpage image, or open its text panel to compare and copy the recognized text.

<GuideVisual kind="image" en />


Recognized text that remains unchanged, including brand names, target-language text and missing translations, also participates in protection. If a neighboring translation would erase or draw over that text, FluentRead preserves it and offers the withheld translation in the text panel. When no translation can be safely drawn on an ordinary image, the page keeps its original image. This protection does not cover unrecognized text or unknown artwork.

For horizontal manga text affected by source protection, a complete translation can be placed in verified white space inside the same closed speech bubble, keeping the original text and artwork. Its text size stays at least as large as the recognized source text. Long-image segments only use placements that remain fully visible. If space is insufficient, text crosses a segment boundary, or the location cannot be confirmed, the complete translation remains available in the text panel. Placement reuses the current result without another OCR call, translation request or model download.

## Translate one image

1. In **Settings → Image/manga translation**, enable webpage image translation and check the source language, target language, and service.
2. Hover over an image for about 0.6 seconds, then click its lower-left translation icon. You can also use the image context menu.
3. Prepare recognition resources when prompted on first use. Once finished, switch between original and translated images, or open **Text → Compare original** to check recognition, read long translations, and copy text.

When you click a translated image and the site's viewer opens the same image, the enlarged view reuses the existing translation without running recognition or translation again.

Choose **Cancel** to stop processing; downloaded resources remain available. The text panel helps when a translation is long or the image is small. Controls hide when you leave the image and return when you hover over it.

Press **Escape** inside the text panel to close it and return to an available entry. Focus stays elsewhere if you have already moved to another page control. Copy feedback follows the current view and latest operation; if copying fails, select the text and copy it manually.

Recognized decomposed Hangul, extended Han characters, and their variation selectors keep their original text form. Layout avoids splitting combining characters and emoji. Complex unbroken words may still require smaller text in older browsers; use the text panel to read them.

During automatic wrapping in ordinary images, closing punctuation stays with the preceding character and opening punctuation with the following text. Small Japanese kana and prolonged sound marks also stay attached. Explicit line breaks are preserved.

When the last line of a short paragraph is much shorter than the others, line widths can be balanced while retaining the current font size, line count and complete words.

Ordinary images use the actual glyph bounds of your device's fonts to reduce clipping of accents, ascenders and descenders. Merged Tesseract vertical text keeps each column's erasure bounds, preserving artwork between columns. For opaque text regions whose complete boundary matches a smooth gradient, ordinary image and manga repair continue that gradient. Complex textures or translucent backgrounds may still show repair artifacts; switch to the original to compare.

Horizontal text uses confirmed source glyph widths and heights from individual lines to estimate font size and align translations within the existing region. This reduces enlargement caused by padding in recognition boxes. Complex fonts, backgrounds and perspective can still affect the result; these estimates do not recover the original font family or decorative style.

On solid backgrounds, reliable source text colors are retained when their contrast is sufficient. Single horizontal lines can receive a little extra drawing height after the entire added area is confirmed to be the same opaque background color and clear of other text. Nearby artwork and transparency limit expansion. Complex backgrounds or uncertain color relationships keep the default dark or white text.

Text on a smooth gradient can also retain a verified source color, with a thin contrasting outline. This reduces white or colored headings being rendered as dark text. Uncertain mixed colors and textures keep their existing handling.

Manga translations use the direction of their paragraph when measuring and drawing text. This helps keep numbers, brackets and punctuation in Arabic and Hebrew text from following an unrelated default canvas direction.

Manga wrapping tries to keep complete words and graphemes together, reducing splits within short Chinese words. Word boundaries depend on the browser's language support; words that exceed the available width can still wrap at complete graphemes.

Small Japanese reading annotations above horizontal text or to the right of vertical text are attached to the body when their size, position and ownership are clear. This avoids translating the reading as a separate text block. The body and annotation keep their original erasure bounds, with padding based on the annotation's own size. Ambiguous annotations, independent small text and already grouped recognition regions retain their existing handling.

For slightly tilted horizontal text in photographs, translations follow the source angle and position when both direction and font scale can be verified. Matching line counts can also retain the observed spacing. The complete rotated text must fit inside the original region; uncertain cases keep the existing layout. Strong perspective, curved text and complex textures can still be reconstructed inaccurately.

Individual translation requests include bounded neighboring text from the same image as reference for services that support context. Batch requests continue to process their existing paragraphs together. Translated images follow the original image's shape clipping and pixel scaling settings.

With a prompt-based AI service (or a composite containing one) and **AI context** enabled, each text region can reference up to two recognized regions before and after it, without an extra summary request. Repeated short phrases retain their own positions and neighboring context; changed context cannot reuse a translation cached for another meaning. Turning the setting off keeps the existing translation behavior. Context can help resolve ambiguity, but recognition errors and model mistakes still require checking the original.

When Google native batching is enabled, complete sentences from an image can share context in groups of up to four, while headings remain separate. The extension checks region identifiers and sentence endings, then falls back to independent translation if a result loses a region, mixes positions or changes an independent sentence into a comma continuation. Repeated phrases keep their positions and group context in the cache. Only recognized text is sent, not the original image; check specific meanings against the source.

Ordinary rotated, scaled, mirrored and perspective images follow the page's native transforms. Styling changes reuse the existing recognition and translation. If overlay alignment or shared ancestor clipping cannot be verified, the original stays visible with an entry to read the translated text. Examples include fixed positioning with rotation, or a rotated image inside an overflow-clipping container that does not establish its positioning reference. A supported layout can display the existing translation again.

Nearby centered small text uses the image's blank space and smooth background to identify continued lines, reducing sentences split across translation requests. Verified spacing corrections retain their original layout relationship. Columns and intervening text or artwork still keep regions separate.

Scaling small text on solid backgrounds, or dark text on slightly varying light gray backgrounds, can join English words and identifiers. When both model evidence and the original glyph gaps support it, missing spaces can be restored, for example from `ROUTEC4` to `ROUTE C4`, or `ISAVED` to `I SAVED`. Existing letters, digits and source bounds stay unchanged.

Image translation also checks text detection evidence alongside recognition to reduce highlights, textures and decorative lines being mistaken for text.

Some horizontal text missed because of surrounding background interference can receive an additional recognition pass. Complex perspective, very small text and faint lettering may still be missed; check the original image.

On a continuous gradient, neighboring lines with clearly different sizes and verified text colors retain separate regions. This helps preserve a heading and subtitle as distinct styles. Same-image context still follows the selected translation service and settings.

Independent labels on a shared background use their actual ink spacing to stay separate, reducing unrelated text being merged when recognition boxes contain excess padding.

In manga mode, neighboring gradient headings with a clear shared left or right edge can keep that alignment for single-line translations. This helps short translations preserve the original hierarchy. Centered text, wrapping, transparency avoidance or insufficient space retain the existing layout.

The default **PaddleOCR (standard model)** prepares about **30 MB** on the first translation and shares its resources with manga. **Tesseract (lightweight model)** uses packs for the selected source language. Changing recognition engines makes the next translation recognize the image again; selecting an engine alone does not start a download.

PaddleOCR automatically enhances recognition contrast for some colored text on light backgrounds and bright text on dark backgrounds, without another model download. Very faint, thin lettering and complex backgrounds can still lose text; check the original or text panel.

## Continuous manga translation

1. Enable **Continuous manga translation** in the same settings, then open a supported reader such as MANGA Plus or a Pixiv artwork reader.
2. Click the manga button. If resources are missing, confirm preparation; choosing Later or closing the prompt starts no download.
3. Visible pages translate first. Scroll to translate more pages, click the manga button again to show originals and pause, and click again to resume.

After starting, expand the controls next to the manga button and choose **View manga text**. Select a visible page or long-image segment to read, compare, or copy its completed text. Click the entry again to close it. Mixed images, canvases, and background images follow document order. Numbers identify the current visible candidates, not chapter page numbers.

The panel reads existing results without starting recognition or translation. It reports when a page is still processing, a result has been released, or content is too large to display; return to the page and check again. A long-image segment may include text from adjacent segments. Canvas text comes from the latest completed translation snapshot and may not reflect later changes to the canvas.

When existing translations were withheld to protect the original, **Undrawn translations** shows their count. Click it to read those complete translations; click again to return to all text in its original order. Switching views reuses the current snapshot without recognition or translation requests. **Copy this section** copies the current filtered section; **Copy all text** still copies all text for the selected page. The image keeps the original text at those positions, such as English. This entry does not erase or redraw the image or fix missed OCR text.

By default, FluentRead prepares the next **3 images** already loaded by the website. Choose **0–5** in settings; 0 translates visible pages only. More upcoming pages use more device resources and translation requests. It does not load an entire chapter or the next chapter for you.

Failed pages keep their originals while other pages continue. Switch to originals and back to retry. Changing chapters, leaving the page, or disabling manga translation stops old work. Image translation and floating-button switches are independent of manga; adjust its separate entry under **Standalone manga button**.

When the original background opacity can be established, transparent cutouts are protected. Text flows around them inside the original text box, preserving its size and whole words where possible. Less available space can still require smaller text; open the text panel to read the full translation. Very complex cutouts or a fully blocked text area leave the original page with an error message.

Search **Supported websites** by name or domain and check the reader type. Some support continuous translation; others offer **Select manga area to translate**, which requires area translation and a drag over visible artwork. Listing a site does not verify every chapter. Login, paid, and protected content still depends on what the website can display. Elsewhere, try a single image or [area translation](/en/guide/area-translation).

<details class="guide-details">
<summary>Manga recognition, resources, and caching</summary>

### Download manga models

Manga normally uses local PaddleOCR, with LaMa to repair lettering on complex backgrounds. Recognition needs about **30 MB** and repair about **197 MB**. Single-image PaddleOCR does not load the manga repair model. For Russian or Korean manga, explicitly select the source language to use its language pack; the automatic manga model does not contain these scripts.

View resource status under **Image/manga translation → Recognition resources**. Expand download management to remove resources or import existing files. Failed connections or checks retry automatically. Complete files are kept and only missing files are downloaded; an incomplete individual file must restart. Imports must match the required names, sizes, and integrity checks and stay on your device.

Once resources are present, recognition and background repair can work offline; text translation still depends on your service. Clearing models does not remove translation settings or other language packs.

Nearby completed pages can reuse cached results. Distant pages or released caches may need processing again. Changed images, languages, services, or recognition engines invalidate old results. Switching tabs pauses the start of new page tasks until you return. Complex pages and first-time preparation can still take time.

Small or decorative text, names, tilted lettering, and background repairs can be wrong. Switch to originals to check. Local manga models use browser-extension capabilities; the userscript version is limited.

</details>

## Missing controls or failed translations

- **No icon:** avatars, icons, emoji, video previews, and small images are usually skipped. Use the context menu or open a clear original. A viewer or menu covering an image temporarily hides its controls.
- **Incorrect recognition:** check the source language and use a clear original. Complex tables, decorative fonts, and vertical text outside Japanese are harder to recognize. Check names, numbers, and units.
- **Recognition fails:** retry as prompted. Failed manga pages retain their originals; switch to originals and back to retry.
- **Translation fails:** retry as prompted or change the image translation service. After an extension update or reload, refresh the webpage first.
- **A local model fails:** use **Adjust local model** to check resources and supported languages, or **Change image translation service**. Return to the image and retry after making changes. Text is not automatically sent to an online service instead.

Supported numeric formats recognized as separate lines, including some times, dates, amounts and percentages, remain in the original image and are not sent individually for translation. If nearby translated text would cover one and no safe placement is available, that text is available in the text panel instead. Protection depends on recognition and format: missed or incorrect recognition, some low-confidence results, and numbers mixed into text lines may not be protected. Check the original. If numeric regions cannot be located reliably, processing reports an error and keeps the original image. URLs, version numbers, and similar identifiers may also remain unchanged. You can still read and copy recognized text when nothing needs translating. Animated images produce a static translation; switch back to see the animation. Repairs may leave visible marks, and the original can always be restored.

<details class="guide-details">
<summary>Source language and language packs</summary>

## Choose the source language

Source and target languages are shared with webpage and area translation. Images and manga share the service chosen here. Fixed settings examples only preview the appearance; they run no recognition and send no translation requests.

Tesseract's **Automatic detection** prepares Simplified Chinese, Traditional Chinese, English, and Japanese by default. For other languages, select the source language explicitly and download its pack. Choosing English for an English-only image can reduce waiting. Japanese supports horizontal and vertical text.

Each language pack shows its own download progress. Leaving settings does not stop downloads. Completed packs remain if another fails; retry only missing packs. Removed packs need downloading again before use.

</details>

<details class="guide-details">
<summary>Cross-origin images</summary>

## Cross-origin images

Public HTTPS images usually work. When the webpage cannot read an image, the extension verifies the current image and retrieves it without login credentials. For Pixiv, only its request for the current image temporarily includes the required site referrer; no login cookies are sent.

Images requiring login, redirecting, or coming from local or intranet sources may be unreadable. Files over 16 MiB, access refusals, and non-image content show a specific reason. Try area translation on visible text.

</details>

## What gets sent?

Recognition and background repair happen locally. Recognized text goes to the selected translation service; image pixels are not uploaded with text translation requests. Initial resource downloads need a connection. See [Data & privacy](/en/guide/privacy).

## Related guides

- [Area translation](/en/guide/area-translation)
- [Troubleshooting](/en/guide/faq)
