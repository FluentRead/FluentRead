# Userscript gzip build budget

The combined changes from #1107, #1108, #1109, #1110 and #1111 produced a 3,621,448-byte standalone script, above the unchanged 3,620,000-byte limit.

The build helper now compares one additional bounded candidate: pako 2.1.0, compression level 9, memLevel 5. Existing memLevel 8/7/9 candidates retain their order; a candidate replaces the current bytes only when strictly shorter. Each asset incurs one additional build-time compression. Runtime decoding, dependencies, resource content and the size threshold are unchanged.

On the combined snapshot, the actual standalone build is 3,619,253 bytes (747 bytes below the limit), with no @require. All 37 gzip-encoded assets were decoded before/after and their byte lengths and SHA-256 hashes matched in order: 2,325,875 uncompressed bytes in total. This is payload identity evidence, not a claim that production runtime has been browser-tested.

Five focused tests cover empty/binary/catalog round trips, unchanged input, deterministic ties and a catalog where memLevel 5 beats the previous candidates. The helper has 100% statements/branches/functions/lines coverage. Four userscript test files (365 cases) pass, including data round trips and build boundary checks. No thresholds were raised and no feature was removed.
