# Recorded manga paragraph replay

`recorded-v14.json` freezes the text and line geometry returned by the failed 14-scene production PaddleOCR run in iteration v14. Its source pages are the existing original fixtures in `manga-color-quality` and `manga-alpha`; the recording does not copy their images, model weights, browser artifacts, translation output or user content.

The regression decodes each pinned fixture PNG, verifies its PNG and RGBA hashes, and feeds the captured source lines through the current production paragraph collector with same-frame gap proofs. The confidence field was not present in the compact capture, so the replay uses synthetic confidence `1` only to reach the already-eligible grouping path. Bubble-owner metadata and the raw Paddle detection tensors were not captured.

In this bounded replay, the current collector starts with 19 paragraph-order failures and the pixel-proof path leaves 14, with no new failure. The original run recorded 20 paragraph-order failures across its output; that number is kept in the recording and differs from this replay baseline because the current collector has changed since the original run. This evidence does not prove new OCR accuracy, exact full-page runtime behavior, live-site compatibility or Gemini translation quality.

The JSON freezes the source-report SHA-256 (`4e03cdc9985cd65f955f5bdca4f91bf6a0bfada7c2092d588b3f32c38043fa7b`) and input-manifest SHA-256 (`d009984c27243ddbd9ed4ddd1c510b7d6b48d38b2234987518e07747cbffc7b5`). The containing test also pins the compact recording file digest.
