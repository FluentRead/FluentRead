# Bundled interface font card previews

These small, modified fonts are packaged with FluentRead solely for font option
labels, descriptions and the existing sample text. They are not the downloadable
interface fonts and are not installed into the user's system. Full interface
fonts remain opt-in downloads and retain their original files and cache behavior.

## Source, modifications and license

The checked-in WOFF2 sources in `assets/interface-fonts/` originate from Google
Fonts revision `809e4d8b8d7e9364a914909bb777679606c178b8`. That directory's `NOTICE.md` and
`manifest.json` document the original upstream files, copyright and hashes.
The generator verifies every source's existing SHA-256 before processing it.
No network download is used during regeneration.

Each weight-700 face contains only the source glyphs needed by that font option's
own title in zh-CN, zh-TW, en-US, ja-JP, ko-KR, fr-FR, es-ES and ru-RU. Each weight-400
face contains its own descriptions, the localized bottom preview and
`Aa Bb Cc · 0123456789`. Noto Sans SC additionally supplies source-supported
characters missing from the other fonts' titles/descriptions at the same weight.
System font option text does not use a preview font. Variable sources are
instantiated at weight 400 and 700 with all other axes at their source defaults.
LXGW WenKai uses its respective
original Regular and Bold sources. Font names are rewritten to independent
`FluentRead Preview …` names. The modified Source Sans 3 primary name is
`FluentRead Preview Humanist Sans`; IBM Plex Sans is
`FluentRead Preview Technical Sans`, avoiding Reserved Font Names Source/Plex.
The CSS aliases identify the corresponding original font options for the UI;
they are not the internal primary names of the modified fonts.

Original copyright, license, author and vendor metadata remain in the files.
The complete upstream copyright notice and OFL text are also embedded in each
font's nameID 13 license record, including when the userscript distributes the
WOFF2 as an inline resource without an accompanying license file.
The complete upstream copyright notices and SIL Open Font License 1.1 are
distributed in [interface-font-licenses.txt](../../public/interface-font-licenses.txt).
All these modified font files remain licensed under SIL OFL 1.1.

Each Latin family shares the bundled Noto Sans SC preview as a fallback for
characters it does not contain. A preview does not add glyphs absent from its
original source: unsupported characters, including most Korean Hangul in these
sources, retain the usual system fallback. `manifest.json` records each face's
actual role requests, its original source's full-corpus coverage, its retained
character mappings and each language's missing characters for that role. Output
outlines and advance/sidebearing metrics are compared to the original source at
the same weight, and all effective stacks retain every source-supported role
character. The maintenance generator reads only original full source assets;
it never relies on previously generated preview subsets.

## Offline reproduction

Run `python3 scripts/fonts/build-interface-font-previews.py` from the repository,
or append `--check` to reproduce and compare without changing any file.
The maintenance script uses Python, fontTools 4.60.2 and Node 20+
with built-in Brotli. These are not extension build or runtime dependencies.
The script keeps original font timestamps so regenerated WOFF2 bytes are stable.
When card copy or its 400/700 rendering roles change, regenerate and review the
new coverage and hashes.

The 18 checked-in WOFF2 faces total 209,020 bytes. Requests
are drawn from a corpus of 423 distinct Unicode
characters and trimmed by font option and weight, retaining each source font's
real outlines and supported mappings.
