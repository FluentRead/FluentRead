# Smart Highlighting

Automatically highlight words in the text to give your reading more focus. Once enabled, Smart Highlighting turns selected words into visual cues for scanning longer passages, locating details and revisiting the text. The complete text remains readable, selectable and copyable, with its original layout.

Smart Highlighting is a separate reading aid. Bilingual sentence highlighting links original and translated sentences; Smart Highlighting marks words in the text. Each has its own settings.

## Use it

1. Open **Settings → Translation settings**, then use the **Smart Highlighting** anchor at the top or scroll down to its settings group.
2. Choose mode, density, colour and drawing style, and check the illustrative preview.
3. Enable **Smart Highlighting** from the FluentRead PDF reader toolbar for the current document. Turn it off to clear the marks.

The top navigation scrolls within the continuous settings page. All groups remain displayed. Smart Highlighting and bilingual sentence highlighting have separate settings groups.

The **Keywords**, **Surprisal** and **Reading aid** tags beside the title explain how it works and what it helps with. Hover, focus with the keyboard or tap a tag to view its explanation. Press Escape or click outside to close it.

Preferences are saved in Settings. Web pages stay off by default; changing preferences or downloading a model does not enable web-page highlighting. The popup has no Smart Highlighting entry.

## Modes

| Mode | Purpose | Processing |
| --- | --- | --- |
| Keywords | Quickly spot topic words | Lightweight local algorithm; no model download |
| Surprisal | Notice words that are less predictable in context | FluentRead downloads Qwen on demand and computes probabilities on your device |

Both modes process page text locally. Downloading a model contacts its hosting service; scoring does not send page text there.

Surprisal is `−log₂ P(word | preceding text)`. A higher value means the model found the word harder to predict. It does not establish importance, correctness or factual accuracy. Names, rare words and typos can all score highly; unmarked conditions and negations may still matter.

## Appearance and performance

Manage mode, density, colour and drawing style in **Settings → Translation settings → Smart Highlighting**. In local-model mode, both **Qwen2.5 0.5B** and **Qwen3 0.6B** cards are displayed. Use the radio beside a card title to select the analysis model; Qwen2.5 0.5B is the default. Each card has one action button: **Download model (size)** before download and **Remove model** afterward. Download and resume first open a confirmation dialog; files are downloaded only after confirmation. Cancel, close or Escape leaves the files unchanged. Removal also requires confirmation and affects only that card’s model files. Choose **Keywords** from the analysis mode selector when a model is unavailable. The preview illustrates appearance rather than model output.

Choose low, medium or high density (high by default; low marks only the key words, medium adds the next tier, high tints every informative word), amber, mint or blue, and a soft background or underline. Appearance and density changes reuse existing scores.

The local model is downloaded and run by FluentRead. It does not depend on AI built into Edge, Firefox or another browser. Qwen2.5 0.5B needs about 490 MB and is the default; the optional Qwen3 0.6B needs about 579 MB. Each uses its own pinned q4f16 ONNX files. Selecting a model does not start a download, and downloaded files are kept separately. The extension uses ONNX Runtime Web in a dedicated Worker and your device's WebGPU to compute scores; analysis works offline once the files are downloaded.

Model download starts only after you confirm the model and size in the download dialog. Model mode requires WebGPU with shader-f16 support. An unavailable page or model displays a reason; you can choose Keywords manually. Page text is never automatically sent to a cloud scorer.

Saved parts are retained when a download is paused or interrupted. Choose **Resume download** and confirm to continue. Selecting another analysis model does not download or delete files; you can also download or manage the unselected card independently. Verification, storage and model-start errors display recovery guidance. Complete model files are not downloaded again. Highlight choices, speed and memory usage depend on the device and text; the newer model does not guarantee more useful reading cues.

Long pages prioritize nearby text and defer analysis during fast scrolling. Turning the feature off cancels work and discards late results. Changes to page text trigger fresh analysis. Editors, forms, code and formulas are excluded from normal body highlighting.

CSS Custom Highlight API support is required; unsupported browsers keep the normal page and show an unavailable state.

## Source

The design draws on [InfoLens](https://github.com/dqy08/InfoLens/tree/205c45b8fac0b2ded7f8aac764fcba5f6b0719db). FluentRead implements it in its own Vue and WXT architecture, with no runtime dependency on the reference repository. Keyword ranking and language-model surprisal remain distinct methods.

In the FluentRead PDF reader, enable **Smart Highlighting** from the toolbar. It uses the selectable text layer and preserves the original page image and layout. Scanned pages without a text layer are excluded.
