# Image layout line-edge punctuation data

`src/features/image-translation/linePunctuationData.ts` contains derived ranges
from Unicode 17.0.0 `LineBreak.txt`, copyright 2025 Unicode, Inc., covered by the
[Unicode License V3](unicode-17.0.0.txt).

Source: https://www.unicode.org/Public/17.0.0/ucd/LineBreak.txt

SHA-256: `e6a18fa91f8f6a6f8e534b1d3f128c21ada45bfe152eb6b1bcc5e15fd8ac92e6`

The pinned original is kept in `tests/fixtures/unicode-17.0.0/LineBreak.txt`.
Regenerate offline with `node scripts/generate-image-line-punctuation-data.mjs`;
append `--check` to verify without rewriting generated code.

The selected classes are OP, CL, CP, EX, IS, SY, IN, NS, CJ, and QU characters
whose documented general category is Pi or Pf. CJ is treated as a nonstarter.
The remaining contextual rules, ambiguous straight quotation marks, dictionary
segmentation, and a complete UAX #14 implementation are outside this subset.
Existing word, grapheme, explicit-line-break and font-fit behavior still applies.
