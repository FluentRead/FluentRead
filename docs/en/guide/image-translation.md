# Image translation

Read translations over a webpage image, or open its text panel to compare and copy the recognized text.

<GuideVisual kind="image" en />

## Translate one image

1. In **Settings → Image/manga translation**, enable webpage image translation and check the source language, target language, and service.
2. Hover over an image for about 0.6 seconds, then click its lower-left translation icon. You can also use the image context menu.
3. Prepare recognition resources when prompted on first use. Once finished, switch between original and translated images, or open **Text → Compare original** to check recognition, read long translations, and copy text.

Choose **Cancel** to stop processing; downloaded resources remain available. The text panel helps when a translation is long or the image is small. Controls hide when you leave the image and return when you hover over it.

The default **PaddleOCR (standard model)** prepares about **30 MB** on the first translation and shares its resources with manga. **Tesseract (lightweight model)** uses packs for the selected source language. Changing recognition engines makes the next translation recognize the image again; selecting an engine alone does not start a download.

PaddleOCR automatically enhances recognition contrast for some colored text on light backgrounds and bright text on dark backgrounds, without another model download. Very faint, thin lettering and complex backgrounds can still lose text; check the original or text panel.

## Continuous manga translation

1. Enable **Continuous manga translation** in the same settings, then open a supported reader such as MANGA Plus or a Pixiv artwork reader.
2. Click the manga button. If resources are missing, confirm preparation; choosing Later or closing the prompt starts no download.
3. Visible pages translate first. Scroll to translate more pages, click the manga button again to show originals and pause, and click again to resume.

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

Numbers, URLs, version numbers, and similar identifiers remain unchanged. You can still read and copy recognized text when nothing needs translating. Animated images produce a static translation; switch back to see the animation. Repairs may leave visible marks, and the original can always be restored.

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
