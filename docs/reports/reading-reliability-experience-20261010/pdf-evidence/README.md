# Selectable Chinese PDF export evidence

Controlled fixtures generated on 2026-10-10 using the production binary download
service, reading renderer, pdf-lib 1.17.1, fontkit 1.1.1 and PDF.js 4.10.38.
No translation service is contacted. The browser run uses isolated headless
Chrome 154 through a local Vite page; it does not establish installed-extension,
Firefox, store-release, or a 50 MB real-document acceptance.

## Verified

- `chinese-mixed-selectable.pdf`: visible Chinese, English, punctuation, numbered
  symbols, and distinct Unicode aliases `·•` / `兀兀`; PDF.js text extraction with
  normalization disabled matches the original string (apart from layout whitespace).
- `chinese-long-continuation.pdf`: 600 repeated Chinese sentences and a unique
  ending continue across nine pages, preserving every character at fixed size.
- `browser-readable.pdf`: complete four-page translation, original diagram image.
- `browser-bilingual.pdf`: selectable source page plus four translation pages.
- `browser-bilingual-layout.pdf`: original page, optional raster layout preview,
  and complete selectable translation pages. Only formulas/figures and the
  optional layout preview remain images.
- `browser-evidence.json`: PDF.js extraction, original page, complete tail,
  Chinese text-layer selection, real Clipboard write/read round trip; cancellation
  closes the generator and leaves both created canvases at width/height zero.
- Poppler PNGs were visually inspected for Chinese glyphs, mixed text, the
  preserved diagram, original page, layout preview, and the complete last line.
  The raw font-subset test additionally compares each glyph outline with the
  original font, catching rendering corruption that text extraction cannot see.

Six targeted files / 122 tests passed: `pdfTextExport` (11), `documentPdfRasterizer` (30),
`pdfTextLayout`, `documentTranslationBinary`, `documentPdfRotation`, and
`documentBinaryLifecycle`. Tests cover missing glyph rejection, font-loading
cancellation, iterator cleanup, no Canvas for text-only export, and two bounded
canvases for many continuation pages including error/cancel/consumer break.
Output PDF and source bytes still occupy memory proportional to document size;
this change bounds the raster working set and does not claim constant total memory.
`pdfReadingFont.ts` additionally passes the focused V8 coverage check with
100% statements, branches, functions and lines; the portable coverage summary
is saved in `pdf-font-coverage-summary.json`.

## Reproduce

```sh
FLUENTREAD_PDF_EVIDENCE_DIR=docs/reports/reading-reliability-experience-20261010/pdf-evidence pnpm exec vitest run tests/pdfTextExport.test.ts
pnpm exec vite --config vitest.config.ts --host 127.0.0.1 --port 5188 --strictPort
FLUENTREAD_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node docs/reports/reading-reliability-experience-20261010/pdf-evidence/run-browser-evidence.mjs
pdftoppm -f 1 -singlefile -r 110 -png browser-readable.pdf browser-readable-first
```

The bundled Regular/400 font reuses the project's fixed official Noto Sans SC
source under OFL 1.1. Its derived source/provenance, 4-byte glyph alignment and
497 separate Unicode alias glyphs are recorded in `public/pdf-fonts/NOTICE.md`.
All 31,036 source glyphs and 30,890 encoded Unicode characters are retained.
The static font is packaged as WOFF2 with glyf/loca transforms disabled so
fontkit can serialize valid TrueType subsets. Raw bundled WOFF2: 4,977,684 bytes;
ZIP-style deflate: 4,979,192 bytes (font asset only, before runtime chunk changes).
SHA256: `ea983e51e010c28a6a03839cffea942243e49342be7307be4f2f283e73ab8127`.
Browser fixture PDFs remain 38-68 KB by embedding only used glyphs. Fonts load
on demand from the extension itself.
