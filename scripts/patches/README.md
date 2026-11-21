# Paddle OCR dependency patch

`ppu-paddle-ocr@6.6.0.patch` modifies `core/base-detection.service.js` and
`core/base-recognition.service.js` from
[ppu-paddle-ocr](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr).
The published file is minified to a single line, so the patch contains that
entire line. The original MIT license is included in
`ppu-paddle-ocr-LICENSE.txt`.

Detection and recognition failures and missing output tensors must propagate
as errors rather than being reported as an empty page or incomplete result. A
successful detection with no text or recognition with no confident characters
still returns an empty list. Debug-mode per-box errors also propagate instead
of silently omitting the affected box. Reassess this patch when upgrading the dependency;
remove it if the upstream behavior has been fixed.
