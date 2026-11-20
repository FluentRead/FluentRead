# Smart Highlighting

Mark words in the text to help you scan and revisit a page. Text stays selectable and copyable, with its layout unchanged. This feature has separate settings from bilingual sentence highlighting.

<GuideVisual kind="highlight" en />

## Use it

1. Open **Settings → Translation settings → Smart Highlighting**, choose a mode and appearance, and check the preview.
2. Enable the shortcut, then press **Alt+H** (Option+H on Mac) on a webpage to turn highlighting on or off for that page. The shortcut is off by default and can be changed.
3. To highlight all pages automatically, enable **Highlight every page automatically**. It applies to open pages and future visits; turn it off to clear the marks.

Enable **Click highlighted words to translate** to open the selection translation card by clicking a highlighted word in a webpage. Keep selection translation enabled.

When enabled only by the shortcut, highlighting turns off after a refresh or navigation and does not affect other pages. The FluentRead PDF reader follows the automatic-highlighting setting and also offers the **Smart Highlighting** toolbar button for the current document. Scanned pages without selectable text cannot be highlighted.

## Modes

| Mode | Useful for | Model download |
| --- | --- | --- |
| Keywords | Spot topic words, names and less common words | None |
| Surprisal | Notice words that are harder to predict in context | Qwen2.5 0.5B Base, about 490 MB |

Both modes analyze the text on your device. Downloading a model contacts its hosting service without sending webpage text there.

A high surprisal score only means the model found a word harder to predict. It **does not establish importance or correctness**. Names, rare words and typos can all be highlighted; unmarked conditions and negations may still matter.

## Appearance and performance

The default **Gradient** style varies the color intensity by score. You can also use a soft background or underline, then adjust density, color and intensity. Switch between **Highlighted / Original** in the preview to compare the reading experience.

Visible paragraphs are processed first; more are added as you scroll. Code, editors, forms, formulas and navigation are excluded. Turning highlighting off clears the marks and stops the analysis. Unsupported browsers keep the normal page and explain why highlighting is unavailable.

<details class="guide-details">
<summary>Download a local model and recover from errors</summary>

Choose **Surprisal**, select **Download model**, then confirm to begin. Closing the confirmation does not download anything. Select **Resume download** and confirm after a pause or interruption. Analysis works offline after download; select **Remove model** and confirm to free its storage.

Model mode needs a device and browser that can run the local model. If the model is missing or cannot run, the current page uses Keywords and explains the reason without changing your saved choice. Page text is not automatically uploaded to a cloud service.

Follow the recovery message after a storage, verification or startup failure, or switch to **Keywords**. Complete model files are reused. The retired Qwen3 option returns to Qwen2.5 Base while keeping switches and appearance settings; downloading the new model still requires confirmation.

</details>

## Source

The design draws on [InfoLens](https://github.com/dqy08/InfoLens/tree/205c45b8fac0b2ded7f8aac764fcba5f6b0719db). FluentRead implements it independently; you do not need to install the reference project.
