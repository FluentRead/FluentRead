# Image translation

Recognize words in a webpage image and read the translation over it. Enable **Image translation** in settings first.

<GuideVisual kind="image" en />

## Continuous manga translation

The manga reader on [MANGA Plus by SHUEISHA](https://mangaplus.shueisha.co.jp/) and artwork pages on [Pixiv](https://www.pixiv.net/) have dedicated adapters. Click the manga button to start. No reading panel opens automatically. On first use with missing resources, a confirmation explains about 30 MB for recognition and an optional 197 MB for text removal. Confirming closes it and starts preparation. Choosing **Later** or closing it starts no download.

With the ordinary floating button hidden, an optional 40 px standalone manga button remains available. Control it under **Image/manga translation → Standalone manga button**. Previously disabled prompt preferences remain disabled. The master and manga switches control availability. Processing, completion and errors stay on the manga button; click it to pause and show originals. No per-image progress or error cards appear during manga reading. Retry controls and text details remain available on the image.

- Click once to enable translation for the current chapter. Visible pages take priority, with the next **3 images** prepared by default. Select **0–5 images** in settings; 0 processes visible pages only. Only images already loaded by the website are prepared, without fetching entire or subsequent chapters. More upcoming images use additional device resources and service requests.
- The current result appears as soon as it is ready. Upcoming results appear when their images enter view. Unloaded images and rapid scrolling can still require waiting. Scrolling alone does not cancel an in-flight task for the same image. Switching away from the tab pauses the start of new page tasks.
- Click again to show originals and pause new work. Another click restores translations and resumes. Visible decoded results switch immediately; nearby results use a cache bounded by image count and pixels. Evicted pages may need processing again.
- Failed pages retain their originals and individual retry controls. Pages with no detected text keep their artwork, and the session continues. Changing chapters, disabling manga translation or the extension, or leaving the page cancels old work and restores originals.

This uses your image translation service and language settings. FluentRead adds no membership or image quota; the selected service's own limits and costs still apply. Other catalogued sites and common reading paths are checked for image readers, with a generic entry shown only when reader images are found. A catalog entry does not mean every site has passed live chapter tests. Canvas, tiled, authenticated or protected readers may require dedicated adapters. Advanced users can add exact domains, reader paths and image selectors under supported sites. Custom rules are not verified site support. Single-image and area translation remain available on other sites.

Pixiv uses images from the current artwork, prioritizing its expanded reader to avoid processing the cover behind it twice. After verifying the current webpage image, the extension temporarily adds Pixiv's referrer only to its own request for that exact CDN image. It does not send login cookies or change the website's own requests. This requires the added `declarativeNetRequestWithHostAccess` extension permission. Local manga models remain an extension capability; userscript capabilities are limited.

Manga uses local PaddleOCR. Closed light speech bubbles are enlarged and recognized individually, nearby lines are grouped into dialogue, and translations use bounded font sizes and wrapping. Local LaMa repairs original lettering on complex backgrounds. Ordinary images and area recognition retain their own OCR language packs. Small or tilted text, decorative fonts, names, and background repair can still be imperfect; use originals or **Text → Compare original** to check.

### Download manga models

Expand **Manga reading resources and downloads** under **Image/manga translation** to view resources grouped by purpose. Expand **Download settings and offline import** to choose a source, import files or clear resources. Ordinary image recognition packs have their own section. Recognition needs about 30 MB. The first complex background also needs an inpainting model of about 197 MB. Settings show the current download source and received bytes; the manga button shows preparation status without covering the artwork.

By default, Hugging Face is tried first, then a backup mirror after connection failure, prolonged inactivity, or integrity failure. You can prefer the mirror instead. Completed verified files are retained, so retrying after cancellation or failure only prepares missing files. An interrupted individual file must restart. Clearing manga models preserves ordinary OCR packs, translation configuration, and source preferences.

For restricted networks, expand **Get offline files**, obtain the four matching files through an accessible source, and select them together with **Import downloaded files**. File names, complete sizes, and SHA-256 hashes must match; imported files stay local and are never uploaded. Once the models are present, recognition and repair can run offline. Your text translation service still needs its own connection.

The backup mirror is an independent third party. Every source uses the same fixed versions and integrity checks. Multiple sources and offline import accommodate differing networks in China, the United States, and other regions; availability still depends on local networks and services and cannot be guaranteed for every country or carrier at all times.

## Translate one image

1. Make sure image translation is enabled. Click the icon near the image’s lower-left corner, or use the image’s context menu.
2. For a new source language, follow the prompt to download its recognition pack and translate.
3. Wait for recognition and translation. Choose cancel if you want to stop.
4. Switch between original and translated image, or open **Text** in a separate reading panel. Compare the recognized original and translation, and copy either the translation or both. Long text remains readable even for small images.

<details class="guide-details">
<summary>Language packs, cancellation and retry</summary>

Canceling a translation does not remove downloaded language packs. Later images can reuse them. If text stays unchanged, you can still read and copy the recognized result.

Numbers, symbols, URLs, version numbers, and clear model identifiers are kept without separate translation requests. Ordinary prose on the same line is still translated. Images with more text require more segments, and the selected service affects the time needed. If a passage fails to translate, the original image stays available for retry; identifiers that need no translation do not cause the whole image to fail.

Language settings show the packs needed for your source language, downloaded packs, and active tasks first. Expand other languages as needed. Download progress is shown per pack; you can leave the settings page and return later. Completed packs are kept when another pack fails. Retrying downloads only missing packs. Removed packs need to be downloaded again.

If the translation connection is interrupted, it retries once automatically and remains cancelable. If it still fails, choose **Retry**. After an extension update or reload, refresh the webpage before trying again.

</details>

<details class="guide-details">
<summary>Cross-origin images</summary>

## Cross-origin images

Images on public HTTPS CDNs can also be translated. When the webpage cannot read their pixels, the extension verifies the currently selected image and reads it without login credentials. Canceling, changing the image, or leaving the page invalidates the previous request.

Images that require login credentials, redirect to another address, or use local or intranet sources may be unreadable. Try [area translation](/en/guide/area-translation) for visible text. Files over 16 MiB, access refusals, and non-image responses report their specific cause.

</details>

<details class="guide-details">
<summary>Choose the source language</summary>

## Choose the source language

Choose the recognition source language in the language-pack manager. This setting is shared with webpage and area translation. The recognition pack must match the image’s language. Automatic detection prepares Simplified Chinese, Traditional Chinese, English, and Japanese by default. Other supported languages require selecting the source language and downloading its pack.

For an English-only image, choosing **English** can reduce recognition time. Keep **Automatic detection** for mixed languages. Completed recognition results are reused, and simultaneous requests for the same image share recognition. Canceling one request does not interrupt the others. Initial language-pack downloads still depend on network speed.

When the source language is automatic or Japanese, the Japanese pack recognizes both horizontal and vertical text. Vertical columns in a manga speech bubble are joined right to left into one passage before translation.

The current translation service and target language are used. Hover and context-menu entries can be turned off separately in image settings.

</details>

<details class="guide-details">
<summary>Small or blurry text?</summary>

## Small or blurry text?

Open a clear original if possible. Decorative fonts, complex backgrounds, tables, and vertical text in languages other than Japanese are harder to recognize. Check names, numbers, and units.

Long translations may appear small inside the picture; use the text view to read them fully. Background repairs may leave marks, and you can always restore the original.

For one small part, try [area translation](/en/guide/area-translation). Unreadable image sources and restricted pages may not work.

</details>

<details class="guide-details">
<summary>Image entry and ignored small images</summary>

Image translation recognizes text inside webpage images and overlays the translation on the image. It is off by default and can be enabled in settings. Once enabled, hover over an image for about 0.6 seconds to reveal a faint icon in its lower-left corner. The icon becomes clear when you hover over it; click to translate.

The hover entry skips common avatars, icons, logos, emoji, video previews, and small images where it can identify them. Video previews on sites such as X/Twitter can be skipped before playback starts, using player or thumbnail markers. Enlarging a small image may still leave the entry hidden. If an image you want to translate has no icon, use its context menu or open a clear original and try again.

</details>

## What gets sent?

Recognition happens locally. Recognized text goes to the selected translation service; image pixels are not uploaded as part of text translation. Initial language-pack downloads require a network connection. See [Data & privacy](/en/guide/privacy).

## Next steps

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
