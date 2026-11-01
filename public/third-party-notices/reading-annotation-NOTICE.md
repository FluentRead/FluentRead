# Offline video reading annotations

These components are used only after reading annotations are enabled for a
supported original subtitle. Executable JavaScript is bundled with the extension.
The large Japanese dictionary and Hindi data are downloaded on demand from
version-pinned sources, verified by exact sizes and SHA-256, and cached for
offline use. Smaller mappings remain bundled. No executable code is downloaded.
No subtitle is sent to the component authors or their services.

## Japanese

- `@faanau/kuromoji` 0.2.1: maintained browser tokenizer fork of
  [takuyaa/kuromoji.js](https://github.com/takuyaa/kuromoji.js), Apache-2.0.
  [Fork source](https://github.com/faanau/kuromoji-js).
  Full code license: `kuromoji-Apache-2.0.txt`; upstream dictionary and NAIST
  IPADIC attribution/conditions: `kuromoji-NOTICE.md`.
  The 12 compressed dictionary files are downloaded unchanged on first use
  from fixed version sources and cached after size/SHA-256 verification; they
  are excluded from the extension package. Decompression and tokenization
  happen inside the extension's dedicated Worker.
- `doublearray` 0.0.2: MIT, Copyright (c) 2014 Takuya Asano.
  [Source](https://github.com/takuyaa/doublearray). This Double-Array trie is a
  runtime dependency of the tokenizer, bundled in the Japanese engine chunk.
  Its exact installed license is supplied in `reading-doublearray-MIT.txt`.
- `kuroshiro` 1.2.1: MIT, Copyright (c) 2015-2026 Hexen Qi <hexenq@gmail.com>.
  [Source and license](https://github.com/hexenq/kuroshiro/tree/1.2.1).
  Full license: `kuroshiro-MIT.txt`. Only the kana-to-Hepburn utility is used;
  FluentRead independently groups structured tokenizer readings as plain text.

## Mandarin

- `pinyin-pro` 3.29.4: MIT.
  [Source](https://github.com/zh-lx/pinyin-pro); full license:
  `pinyin-pro-MIT.txt`.
- `@pinyin-pro/data` 1.3.1: only the traditional-to-simplified character mapping
  is bundled. Published npm metadata declares ISC and omits a LICENSE file.
  The exact npm `gitHead`,
  [815fe17f80fc7a76aa2b21a842e68229e4b72a4a](https://github.com/chinese-data/pinyin-pro-data/tree/815fe17f80fc7a76aa2b21a842e68229e4b72a4a),
  has an explicit MIT LICENSE, Copyright (c) 2024 Chinese-Data.
  Both the original source license (`reading-pinyin-pro-data-MIT.txt`) and the
  published ISC declaration/conditions (`reading-pinyin-pro-data-ISC.txt`) are
  supplied. The mapping is used unchanged, without the optional modern or
  complete dictionary bundles.

## Korean

`koroman` 1.0.16: MIT, Copyright (c) 2025 Donghe Youn.
[Exact npm source revision](https://github.com/gerosyab/koroman/tree/e529729b923f8a9d9acc62b2c9c0887b00e9bd88).
The npm package omits LICENSE. The corresponding repository LICENSE contains
unresolved merge markers around a complete MIT grant. The exact original is
preserved byte-for-byte inside `reading-koroman-upstream-LICENSE.txt.gz`; the same complete grant
with only conflict-marker lines and duplicate heading removed appears in
`reading-koroman-MIT.txt`. Implementation code is used from the unmodified
published package.

## Thai

`thai-rtgs` 0.1.3: MIT, Copyright (c) 2026 PhaiKub.
[Source](https://github.com/PhaiKub/thai-romanization-RTGS); full license:
`thai-rtgs-MIT.txt`. FluentRead uses its syllable parser and irregular-word
dictionary; a reported unparsed fallback leaves that subtitle unchanged.
RTGS omits tone and vowel-length distinctions.

## Hindi static code and on-demand data

FluentRead's `src/features/video-subtitle/reading/hindiEngine.ts` is a TypeScript
port of the Hindi implementation from `@budhash/gomanize` 1.2.1, MIT,
Copyright (c) 2023-2026 Budhaditya (budhash@gmail.com); full license:
`reading-gomanize-MIT.txt`.
[Exact npm source revision](https://github.com/budhash/gomanize/tree/3e519d5cfb689c2444545396e4cfab24d3a2d84a).
The port preserves the parser, consonant runs, rule scopes and phase order,
lexicon-first lookup, default/learned-schwa candidate generation, and UTF-8
character-ngram scoring for the existing `lexicon:true, rerank:true` behavior.

The extension no longer ships or runs gomanize WASM or the Go runtime. All
executable Hindi code is static bundled TypeScript. The original npm WASM and
Go runtime are used only as development parity oracles; their historical hashes
are retained in `reading-annotation-PROVENANCE.json`. The Go project license is
retained in `reading-Go-BSD-3-Clause.txt` for that historical record.

These separately licensed pure-data artifacts are downloaded from the fixed
source revision on first use, verified against exact byte sizes and SHA-256,
and stored in a versioned offline cache. Neither data source can supply code.

| Source file | Origin and transformation | License |
| --- | --- | --- |
| `lang/hindi/lexicon.tsv` | Google Dakshina Hindi train spellings, high-attestation winner per word; Shabd frequency ranking (CC0); TSV serialization | CC BY-SA 4.0 |
| `lang/hindi/schwa_tree.json` | Decision tree learned from aligned schwa positions in Dakshina Hindi train data | CC BY-SA 4.0 |
| `lang/hindi/roman_ngrams.tsv` | Character 4-gram counts from Dakshina Hindi train romanizations | CC BY-SA 4.0 |

The three unchanged downloads total 472,254 bytes. A test-only subset in
`tests/fixtures/video-reading-hindi-parity.json` retains selected lexicon entries,
the unchanged schwa tree, all unigram counts and the additional ngram counts
needed by the frozen original-WASM corpus. That derived data remains CC BY-SA
4.0 and is excluded from the extension output. The subset and expected readings
are compatibility fixtures, not an independent pronunciation assessment.

Google Dakshina: Google / Brian Roark, Daan van Esch, Colin Allauzen, Michael
Riley, 2020. [Original dataset and authorship](https://github.com/google-research-datasets/dakshina).
Full license: `reading-Dakshina-CC-BY-SA-4.0.txt`, also
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Shabd: [psycholinguistic database](https://osf.io/xfbhd/), CC0; credited for
transparency. Source artifacts and reproducible training/build tools are
available in the exact gomanize source revision above; its
[research record](https://github.com/budhash/gomanize/blob/3e519d5cfb689c2444545396e4cfab24d3a2d84a/docs/RESEARCH.md)
describes datasets, exclusions and transformations. FluentRead makes no further
changes to the downloaded artifacts and does not relicense them under the
implementation code's MIT license.

The published 1.2.1 package predates the upstream separate embedded-data NOTICE.
For transparency the later upstream `npm/NOTICE.md` is included unchanged as
`reading-gomanize-upstream-NOTICE.md` (Git blob
`a02cf9893b301d178e5e4973051e85bbc4726230`). That later document also lists Bengali
data in newer builds; FluentRead's port of the fixed 1.2.1 engine is Hindi-only. This
version-specific record and the full data license supplement that upstream
notice. No attribution implies endorsement by an upstream author or dataset
creator.

## Russian, Greek and Arabic rules

FluentRead implements plain-text mappings independently, with reference to
Unicode CLDR transform documentation/data. Unicode license and attribution are
retained in `unicode-17.0.0.txt`.
[CLDR source](https://github.com/unicode-org/cldr/tree/main/common/transforms).
Russian preserves written stress; modern Greek handles common digraphs and
written stress. Arabic transcribes written vowels and explicit gemination;
missing short vowels are not inferred. These annotations do not claim to be
complete phonetic transcriptions.
