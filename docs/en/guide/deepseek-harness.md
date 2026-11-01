# Selection translation

Select a word or sentence to translate, look up a word, listen to it or request an AI explanation in one card.

<GuideVisual kind="selection" en />

## Translation card

1. Enable **Settings → Selection translation**.
2. Select text on a webpage and click the icon beside it.
3. The card opens on **Translate**. English dictionary lookup works without AI setup.

Use the share or save buttons to keep a result. Drag the top or blank space around the card to move it, and drag its edges to resize. Long content scrolls inside. The next selection restores the default size near the selected text.

For “Invalid key or permission”, choose **Configure service**, then check the key and permissions under **General → Service assignments → Selection translation → Configure connection**. Return and retry manually.

## Optional AI explanations

Enable **AI explanations** in selection settings, choose a service and model, then select an action in the card. Opening the card alone does not request an AI explanation.

| Action | What it explains |
| --- | --- |
| Understand | Meaning, tone and references |
| Parts of speech & syntax | Sentence structure, word classes and syntactic roles |
| Usage | Common collocations and natural expressions |
| Practice | A short exercise based on the source |

<GrammarDemo en />

**Bilibili translation · Free** provides basic **Understand** and **Usage** without an API key. Select **Free AI explanations** in the card to use it for the current selection. Syntax, practice and follow-up conversations require a general AI service; configure it under [Translation providers](/en/config/translation-engines). Existing service and action preferences are preserved.

Click a grammar fragment or use the left/right arrow keys to explore it. The original appears above its role and word class. Analysis that cannot be matched to the source remains a text answer. AI explanations can be wrong; check them against the original.

## Check the source behind an explanation

Small quote marks at sentence ends show source references. Hover to read a quote; click or press **Enter / Space** to return to the original sentence. After the page changes or you leave it, old references remain readable but no longer locate the current page.

Use **More actions** (⋯) to view the original, regenerate an answer, expand to a sentence, listen or open history. Switching learning actions within the card reuses completed answers. After changing the source, model, language or explanation preferences, old answers are not reused; request an explanation again when needed.

## Read-aloud settings

Choose an online voice or local speech in selection settings. An empty voice is selected by language. **Local only** never uses an online fallback; local models must first be downloaded to this browser.

Use the bottom bar to stop, see playback time or skip backward and forward 5 seconds. Skipping is unavailable for browser system speech. Word highlighting follows playback; audio without word timestamps uses estimated timing and may be imprecise. Stopping, closing the card or changing the selection ends playback.

<details class="guide-details">
<summary>Activation and display</summary>

## Activation and display

Choose an icon, dot, direct popup, hover-over-icon, shortcut or context-menu activation under **Activation and display**. Adjust the delay there. Hover mode opens after you pause over the icon. Shortcut and context-menu modes hide floating entries.

The default **Show icon** lets you open the card when needed. **Dismiss when continuing to read** is on by default: scrolling the page, copying the original or leaving an unopened entry hides it. Scrolling and copying inside the card keep it open. Turn this off to compare a translation while scrolling the page.

Press **Escape** or click another page control to close. The old selection does not reopen on its own; select again or use your shortcut. Disabling selection translation stops the card and learning features while keeping their preferences.

</details>

<details class="guide-details">
<summary>English dictionary and bidirectional translation</summary>

## Dictionary and card controls

Choose a source in **Selection translation → Translation card → Dictionary source**. **Default (automatic)** uses the local dictionary first, then online sources when needed. You can also select ECDICT, Youdao, Free Dictionary API, Wiktionary, WiktApi, or Datamuse. ECDICT is available in the browser extension. A selected source is queried on its own; if it has no entry, the ordinary translation remains available and you can retry the dictionary. Changing the source refreshes an open English word card while keeping its ordinary translation.

The default strategy and ECDICT source include 3,000 common English entries with no extra download. A missing entry starts a background download of the verified complete dictionary, about 3.9 MB, for later local lookup; the default strategy also queries online sources. Common entries remain available if the download fails. The dictionary download URL does not include the queried word.

Dictionary word classes describe possible uses, not necessarily a word's role in the current sentence. For a Chinese or English target language, enable bidirectional selection translation to reverse direction based on the selected text.

</details>

<details class="guide-details">
<summary>Context and records</summary>

## Context and records

**Source context** can send the selection alone or allow its paragraph up to a length limit; it does not read the entire page. **Custom instructions** affect AI explanations only, leaving translation and dictionary lookup unchanged.

**Save original** adds text to **Words & sentences** in the [Learning center](/en/guide/vocabulary-book). **Save study note** adds the source and explanation to **Study notes**, where you can keep, edit or delete them. **Use study notes in answers** is off by default; enabling it supplies relevant notes to explanations and writing. Turning it off keeps the notes.

Reading conversations stay on this device for 30 days. Viewing history does not call AI, and private windows do not read or save history. Only requesting an action, regeneration or follow-up sends the selection, permitted context and necessary conversation to your chosen provider. See [Data and privacy](/en/guide/privacy).

</details>

## Related guides

- [Parts of speech & syntax](/en/guide/sentence-analysis)
- [Troubleshooting](/en/guide/faq)
