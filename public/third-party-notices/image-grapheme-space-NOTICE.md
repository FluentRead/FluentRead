# Image layout grapheme-space data

`src/features/image-translation/graphemeSpaceData.ts` contains ranges derived from
the Unicode 17.0.0 `GraphemeBreakProperty.txt` data file, copyright 2025 Unicode, Inc.
It is covered by the [Unicode License V3](unicode-17.0.0.txt).

Source: https://www.unicode.org/Public/17.0.0/ucd/auxiliary/GraphemeBreakProperty.txt

SHA-256: `d6b51d1d2ae5c33b451b7ed994b48f1f4dc62b2272a5831e7fd418514a6bae89`

The original file is retained in `tests/fixtures/unicode-17.0.0/` for offline
verification. Regenerate with `node scripts/generate-image-grapheme-space-data.mjs`;
append `--check` to verify the generated file without changing it.

Only the Extend, SpacingMark, ZWJ and Prepend properties are included. They are used
to keep ASCII-space boundaries safe when `Intl.Segmenter` is unavailable; this is
not a complete implementation of Unicode text segmentation. The rules are pinned
to https://www.unicode.org/reports/tr29/tr29-47.html (Unicode 17.0.0).
