# Userscript gzip build budget

## Historical combined snapshot (2026-10-26)

The combined changes from #1107, #1108, #1109, #1110 and #1111 produced a 3,621,448-byte standalone script, above the unchanged 3,620,000-byte limit.

The build helper now compares one additional bounded candidate: pako 2.1.0, compression level 9, memLevel 5. Existing memLevel 8/7/9 candidates retain their order; a candidate replaces the current bytes only when strictly shorter. Each asset incurs one additional build-time compression. Runtime decoding, dependencies, resource content and the size threshold are unchanged.

On the combined snapshot, the actual standalone build is 3,619,253 bytes (747 bytes below the limit), with no @require. All 37 gzip-encoded assets were decoded before/after and their byte lengths and SHA-256 hashes matched in order: 2,325,875 uncompressed bytes in total. This is payload identity evidence, not a claim that production runtime has been browser-tested.

Five focused tests cover empty/binary/catalog round trips, unchanged input, deterministic ties and a catalog where memLevel 5 beats the previous candidates. The helper has 100% statements/branches/functions/lines coverage. Four userscript test files (365 cases) pass, including data round trips and build boundary checks. No thresholds were raised and no feature was removed.

## Current upstream integration (2026-10-31)

The candidate integrates upstream `11d6a055a6ab87321651840d68c97e162b6e4ae6`, preserving its isolated Zopfli worker and Base91 standalone data format. The ordinary gzip baseline adds memLevel 5. Standalone no longer repeats that same unfiltered candidate after the strategy candidates, because the baseline already considered it. Dependencies, data contents and verifier caps are unchanged.

- All 459 focused tests pass under strict coverage. Both changed build modules have 100% statements/branches/functions/lines coverage.
- The first two instrumented runs had 5-second fixture timeouts. The image test now checks and executes the same generated source instead of compressing both images twice. The settings-registration test uses the real settings AST/compressor and complete label tables, while substituting only the unrelated large UI-message worker with its lossless pako baseline. Dedicated real-worker tests remain intact. Final coverage runs one worker; no timeout or coverage threshold was raised.
- Standard userscript verification: 1,953,944 bytes. Standalone verification: 3,608,583 bytes, no `@require`, below the unchanged 3,620,000-byte cap by 11,417 bytes.
- Type checking passed with a 4 GiB heap and serial resource scheduling.

These measurements are for this integrated candidate, not a paired before/after size comparison with current upstream. Historical 37-asset payload hashes above are not newly measured evidence. Focused tests cover current round-trip and ownership contracts; production browser runtime acceptance is not claimed.
