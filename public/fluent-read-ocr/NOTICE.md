FluentRead bundles the following open-source OCR assets for local image text recognition:

- Tesseract.js 7.0.0, Apache-2.0
- tesseract.js-core 7.0.0, Apache-2.0
- The worker's bundled dependencies retain their notices in
  worker/worker.min.js.LICENSE.txt. The Apache-2.0 license is included in
  LICENSE.md.

Original distributions and readable sources:

- Tesseract.js 7.0.0: https://www.npmjs.com/package/tesseract.js/v/7.0.0
  and https://github.com/naptha/tesseract.js/tree/v7.0.0
- tesseract.js-core 7.0.0: https://www.npmjs.com/package/tesseract.js-core/v/7.0.0
  and https://github.com/naptha/tesseract.js-core/tree/v7.0.0

The worker and WebAssembly code are loaded from this extension's own resources.
The build derives guarded JavaScript corrections from the pinned upstream files;
the distributed WebAssembly bytes remain unchanged. No OCR code is downloaded from a
third-party CDN at runtime.

Language traineddata (including eng, chi_sim, jpn and requested vertical variants)
is downloaded on demand from jsDelivr's Tesseract language-data packages and cached
in the extension's IndexedDB. These MIT-licensed language models are not bundled
in the extension. Downloading them requires a network connection; cached models
are reused locally. OCR image pixels are processed locally.
