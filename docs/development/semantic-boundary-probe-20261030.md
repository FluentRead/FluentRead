# Semantic boundary robustness probe, 2026-10-30

This is a small offline corpus-boundary agreement check, not a subtitle accuracy claim or evidence that rules alone are sufficient. It uses no model calls. Texts are not redistributed; pins, selected record IDs and aggregate observations are in [the result manifest](./semantic-boundary-probe-20261030.json).

## Protocol and provenance

Primary sources are the test sets in [English EWT](https://github.com/UniversalDependencies/UD_English-EWT/tree/4a4d77f599ea53cc405f85d0cec4b2f14f81d42b), [Chinese GSD](https://github.com/UniversalDependencies/UD_Chinese-GSD/tree/22f73e87f7ddc530bb131a6b7587971a03e1a712) and [Japanese GSD](https://github.com/UniversalDependencies/UD_Japanese-GSD/tree/7bc20119f476b552635e0640644e577b6fd3606b). Their annotation licenses do not grant blanket redistribution rights for all underlying third-party texts.

An initial development probe contained 196 English and 200 each Chinese/Japanese records. It exposed repeated terminal punctuation becoming standalone fragments, and apostrophe/ampersand-connected final letters being mistaken for initials. These examples are now development evidence, not an untouched test set.

A separate holdout was selected before inspecting its outputs: 177 English records from 43 complete unused documents, plus the next 200 Chinese and 200 Japanese records. No sentence overlap or English document overlap with development. English traversal accepts whole documents fitting each genre's remaining 40-record budget; final genre counts are weblog 29, email 35, newsgroup 33, answers 40, reviews 40. Original record order and ID gaps are retained. Candidate source was frozen before holdout evaluation; its SHA-256 is recorded in the manifest.

- English groups preserve corpus document/paragraph order, capped at five records, but replace intervening layout with one space. They are not reconstructed webpages.
- Chinese and Japanese groups concatenate five records with no separator. These are explicitly **synthetic adjacencies**, not verified contiguous discourse. Each Japanese record was originally a separate document.
- Each group is one synthetic cue. Cue seams, timing, speaker changes and playback are not tested.
- Gold boundaries are record ends, excluding the final stream end. Trailing whitespace is canonicalized for comparison. Every emitted internal boundary counts, including intentional length-driven fragmentation.
- Single-record results report unintended splits and preservation; F1 is not meaningful when there are no positive gold boundaries. `strong` in the JSON is only a score-filtered diagnostic, not a separate product mode.

## Untouched holdout results

| Language | Gold internal boundaries | Baseline TP / FP / FN | Candidate TP / FP / FN | Boundary F1 |
| --- | ---: | --- | --- | --- |
| English | 91 | 78 / 26 / 13 | 78 / 6 / 13 | 0.8000 → 0.8914 |
| Chinese, synthetic | 160 | 159 / 1 / 1 | unchanged | 0.99375 |
| Japanese, synthetic | 160 | 153 / 1 / 7 | unchanged | 0.97452 |

All input text was preserved and no input exceeded the bounded implementation limits. English has 86 total groups, of which only 45 contain multiple records; exact multi-record groups improved 26/45 → 32/45. Chinese exact groups were 38/40 and Japanese 34/40. In single-record tests, unsplit English records improved 164/177 → 173/177; Chinese and Japanese each remained 199/200. This is not a representative production sample or a statistically established accuracy guarantee.

Fourteen separate synthetic regressions compared both implementations: the old source failed 11, while the candidate passed all 14, including genuine initial/abbreviation preservation. Candidate algorithm version 2 rejects prior-version requests before provider invocation, preventing mixed candidate protocols.

## What remains unsolved

Headings, signatures, UI fragments, unpunctuated prose, embedded-name punctuation and trailing emoticons do not always align with punctuation-based units. Do not label legitimate UD units annotation errors or remove them to improve scores. Length-limited playback groups and sentence boundaries are different targets.

AI cannot select a missing candidate ID. The holdout still contains 1/1/2 missing gold candidates in English/Chinese/Japanese. The development Japanese probe additionally showed a representation tradeoff: making a punctuation run atomic can merge a synthetic record boundary where one record ends in punctuation and the next begins with punctuation; recall changed 156/160 → 155/160 while its 13 false boundaries disappeared. This is disclosed rather than hidden behind the improved F1.

No real-provider AI advantage, human reading comfort, latency acceptance, natural ASR punctuation recovery or browser interaction quality has been established here. Those require separate realistic user journeys and a fresh, representative evaluation set. Future tuning on this holdout must relabel it development data.

## Reproduction

Use the pinned CoNLL-U files and selected IDs in the manifest. Preserve each `# text`, sentence ID and propagated document/paragraph ID in `en_ewt.json`, `zh_gsd.json`, `ja_gsd.json`, each with `{language, dataset, source_commit, records: [{sent_id, text, document_id, paragraph_id}]}`. Keep texts in temporary local storage. Run `node scripts/testing/probe-semantic-boundaries.mjs INPUT_DIR [SOURCE_TS]` with the repository's pinned TypeScript dependency. It performs no fetch/model calls and writes only ID-level case metrics, aggregates and source hash to `INPUT_DIR/results.json`. To reproduce the baseline, provide the semantic source from commit `a3d85fbf45b6b50bd57e42bbd69b2326bb889308`.
