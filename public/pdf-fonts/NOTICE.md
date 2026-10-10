# PDF reading font

`FluentReadNotoSansSC-Regular.woff2` derives from the existing project Noto Sans SC
interface font. Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved
Font Name 'Source'. Licensed under SIL Open Font License 1.1; see `OFL.txt`.
The derived font is renamed, fixes the `wght` axis to Regular/400, and keeps all
31,036 source glyphs and 30,890 encoded Unicode characters. It adds 497 duplicate
outlines for distinct Unicode aliases, resulting in 31,533 glyphs.
The reserved name is not used by the derived font.

## Fixed source

Google Fonts revision: `809e4d8b8d7e9364a914909bb777679606c178b8`.

- Original TTF: https://raw.githubusercontent.com/google/fonts/809e4d8b8d7e9364a914909bb777679606c178b8/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
- Original license: https://raw.githubusercontent.com/google/fonts/809e4d8b8d7e9364a914909bb777679606c178b8/ofl/notosanssc/OFL.txt
- Original TTF SHA256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
- Existing equivalent WOFF2: `assets/interface-fonts/NotoSansSC.woff2`, SHA256 `aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a`.
- Derived WOFF2 size: 4,977,684 bytes.
- Derived WOFF2 SHA256: `ea983e51e010c28a6a03839cffea942243e49342be7307be4f2f283e73ab8127`.

## Reproduction

Run the offline maintenance script with Python 3.9, FontTools 4.38.0 and
Node.js 20.11.1 (built-in Brotli 1.0.9, font mode, quality 11):

```sh
python3 scripts/fonts/build-pdf-reading-font.py /path/to/NotoSansSC-variable.ttf
```

The original source hash is checked. Without an argument the script uses the
existing WOFF2 resource (its decoder also needs Brotli). Neither Python nor
FontTools is a runtime/build dependency. FontTools writes WOFF2 with glyf/loca
transformations disabled; compression uses Node's built-in Brotli. No extra Python compressor is needed
when using original TTF input. The `head` timestamp is preserved.
Source glyph records are aligned to four bytes: fontkit 1.1.1 uses short `loca`
offsets in small TrueType subsets without padding odd glyph sizes. Alignment
prevents those offsets from truncating and corrupting visible glyph outlines.
The WOFF2 glyf/loca transformation is disabled because fontkit 1.1.1's PDF subset
encoder cannot serialize its transformed glyph tables as TrueType records;
otherwise it emits invalid glyphs and oversized output. The raw aligned tables
are still Brotli compressed. All original 30,890 encoded characters are retained.
Unicode aliases such as U+00B7/U+2022 and U+5140/U+FA0C receive separate glyph
IDs with identical outlines so pdf-lib keeps their distinct ToUnicode mappings.

The static TrueType font, packaged as WOFF2, avoids the variable font's default Thin face and
the CFF subset corruption observed with Noto CJK OTF in fontkit 1.1.1. Every
export embeds a subset of the used glyphs with visible text and Unicode mappings.
The complete asset is bundled for offline PDF export and loaded only when a
text PDF is downloaded, without contacting a third party or joining the content
script bundle. Exported documents are not subject to the OFL.
