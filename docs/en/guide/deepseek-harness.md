# Selection translation

Select a word or sentence to open its translation card, look up words, explore sentence structure or continue learning.

<GuideVisual kind="selection" en />

## Translation card

Open **Settings → Selection translation** and enable the feature. Every selection uses one card, opening the first **Translate** tab. Choose **Understand, Grammar, Usage, Practice or History** when needed. Switching tabs reuses the translation. The settings preview uses fixed examples and sends no requests.

English dictionary lookup does not require AI. Dictionary meanings are grouped by word class; these describe possible uses, not necessarily the word’s role in the current sentence. If lookup fails, the translation remains available.

<details class="guide-details">
<summary>Activation and display</summary>

## Activation and display

The card supports icon, dot, direct popup, hover-over-icon, shortcut and context-menu activation settings. Hovering opens the popup after the configured wait; moving away cancels it. Shortcuts and context-menu mode do not show an extra toolbar.

For fewer interruptions, keep the default **Show icon** and click only when needed. A custom shortcut or context-menu mode hides floating entries entirely. Direct popup is suited to repeated lookups; it can interrupt people who select text while reading. Upgrades preserve your chosen activation method.

**Dismiss when continuing to read** is on by default. Scrolling the page or copying the original dismisses the popup, and moving away from an unopened entry hides it after a short grace period. Native selection and copying remain intact. Scrolling or copying within the card keeps it open. Turn this preference off to compare a translation while scrolling the page.

Escape or a click elsewhere closes the popup. A dismissed selection does not reopen by itself. Disabling Selection translation stops the card while keeping learning preferences.

</details>

<details class="guide-details">
<summary>Dictionary and card controls</summary>

## Dictionary and card controls

The card includes 3,000 common English dictionary entries that work without a separate download. For other words, the online dictionary can show a result while FluentRead downloads and verifies the full dictionary for later local lookup. The complete file is about 3.9 MB and is cached after downloading. If the download is unavailable, common local entries and the online dictionary remain usable. The dictionary download URL does not include the word you are looking up.

The card keeps its position when switching learning tabs, streaming answers, or starting and stopping speech. Long content scrolls within the available space. Drag the card by its top or surrounding blank space to move it. Drag an edge or corner to resize it; long text scrolls inside. The next selection opens a new card at its default size near the selected text.

When the target is Chinese or English, the card's language button can change the direction for this result without changing page translation settings. Selection behavior and language preferences are configured under **Selection translation**.

</details>

## Optional AI explanations

Enable **AI explanations** and select a configured AI service and model on the right. Switch between learning actions in the preview on the left. Both columns have equal width and height on desktop; narrow screens show the preview above the settings. Opening a card does not call AI. Choose an action to request an explanation:

- **Understand** explains meaning, tone and references.
- **Parts of speech & syntax** explains the sentence structure and labels source fragments.
- **Usage** teaches natural expressions and collocations.
- **Practice** provides a short exercise.

<GrammarDemo en />

Choose a phrase to read its explanation, or ask a follow-up below the answer. Opening the card itself does not call AI.

<details class="guide-details">
<summary>Explanation controls and answer reuse</summary>

Meaning, Grammar, Usage and Practice start at the explanation. Short answers fit their content; long answers scroll inside the card. Manually resized cards keep the chosen size. Choose View original in More actions to expand the complete source and its matching ordinary translation, then Back to current reading to close the comparison. Entering learning lets ordinary translation finish; late translations and streaming updates preserve your reading position. Clicking the current tab preserves your position and unsent follow-up. Changing the source or expanding a sentence never attaches an old selection’s translation to different text.

The compact Grammar tab opens parts-of-speech and syntax analysis. Grounded sentence structure appears at the top of the answer, even when the AI places its analysis table after a long explanation. Source fragments appear in order as compact two-line annotations: the original above, with the syntactic role and word class always visible below. Punctuation stays with the preceding fragment. This gives an overview without clicking every word. Common role names and word classes use the interface language. Units retain meaningful phrases, such as “subject · noun phrase”; unrecognized names retain the AI’s existing summary, while duplicate or unknown labels are reduced without inventing a classification. Click a fragment or use the left/right arrow keys for its meaning and complete role explanation. General word-class explanations expand on demand. A noun may be a subject in one sentence and an object in another. The default grammar prompt requests a compact table that the interface matches to the source in order. Unmatched or incomplete output, and custom formats, remain readable as ordinary text. AI analysis may be wrong; check the original when in doubt.

Completed answers are reused when switching learning actions within the current card. Choose Regenerate in More actions for a new answer, return to the translation, or ask a follow-up. More actions also contains source speech, sentence expansion, saving, reading history and settings. Changing the source, model, language or learning preferences invalidates related cached answers.

</details>

<details class="guide-details">
<summary>Context and records</summary>

## Context and records

**Source context**, **Study notes** and **Custom instructions** have their own visible sections. Choose the selection alone or allow its paragraph with a length limit; the whole page is not read. You can save and manage notes at any time. **Use study notes in answers** is off by default and, when enabled, supplies relevant notes to AI explanations and writing. Turning it off preserves your notes. The instruction editor applies only to AI explanations, leaving translation and dictionary lookup unchanged. Custom prompts are preserved.

**Save original** adds expressions to **Words & sentences** in the [Learning center](/en/guide/vocabulary-book). **Save study note** stores the source and explanation in **Study notes**. After saving, **View study notes** opens that tab directly; entries are kept until you edit or delete them. Reading conversations stay on this device for 30 days. Viewing records sends no model request. Private windows do not read or save history. See [Data and privacy](/en/guide/privacy).

</details>

<details class="guide-details">
<summary>Existing preferences</summary>

## Existing preferences

Upgrades preserve services, custom models, actions, context and prompts. Existing standalone cards migrate to the unified feature, including their activation method when ordinary selection translation was disabled. Old settings links still work.

Learning conversations continue to use the browser adaptation of DeepSeek Harness, without requiring a DeepSeek model. [Source and license](https://github.com/FluentRead/FluentRead/blob/main/public/third-party-notices/deepseek-harness-MIT.txt)

</details>

## Read-aloud settings

Online voices and local speech settings are available in selection translation settings. The source policy controls which is tried first. Choosing local-only keeps reading text local.

Local speech models are downloaded on demand and stored in the current browser. The model row shows a progress bar, percentage and downloaded size while downloading, and reopening settings picks up a download that is still running. Simplified Chinese browser environments try two Hugging Face mirrors first; other environments try the official source first. Connection or transfer failures advance to another source. Downloaded files are reused, with one cached copy per pinned version.

## Related guides

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
