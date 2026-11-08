# HTML entity decoding and article extraction

FluentRead uses `entities` 4.5.0 to decode HTML character references. The package
is distributed under the BSD 2-Clause license; see `entities-BSD-2-Clause.txt`.

FluentRead uses `defuddle` 0.19.6 for article extraction. Its browser extension
build adapts the entity-decoding call in a copy of the distributed JavaScript;
the original package is not modified. Defuddle is distributed under the MIT
license; see `defuddle-MIT.txt`. The build adaptation checks the complete input
SHA-256 before applying its targeted change.
