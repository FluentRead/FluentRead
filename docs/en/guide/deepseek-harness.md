# Selection translation

Select text to see its translation beside the original. The former translation card is now part of Selection translation, with one entry, activation method and master switch.

## Choose a default view

Open **Settings → Selection translation** and enable the feature.

- **Simple translation** shows the source and translation with copy and speech controls.
- **Card mode** adds dictionary pronunciations and word classes, with optional AI learning actions.

Switch views inside a popup at any time, reusing its translation. This changes only the current selection; the next selection uses your saved default. The settings preview uses fixed examples and sends no requests.

Simple translation keeps language and view controls in one compact toolbar, with copy and speech controls beside the text. Dictionary cards put pronunciations on a shared row when space allows.

Simple translation uses the default translation service. English dictionary lookup does not require AI. Dictionary meanings are grouped by word class; these describe possible uses, not necessarily the word’s role in the current sentence. If lookup fails, the translation remains available.

## Activation and display

Both views share the icon, dot, direct popup, hover-over-icon, shortcut and context-menu activation settings. Hovering opens the popup after the configured wait; moving away cancels it. Shortcuts and context-menu mode do not show an extra toolbar.

For fewer interruptions, keep the default **Show icon** and click only when needed. A custom shortcut or context-menu mode hides floating entries entirely. Direct popup is suited to repeated lookups; it can interrupt people who select text while reading. Upgrades preserve your chosen activation method.

**Dismiss when continuing to read** is on by default. Scrolling the page or copying the original dismisses the popup, and moving away from an unopened entry hides it after a short grace period. Native selection and copying remain intact. Scrolling or copying within the card keeps it open. Turn this preference off to compare a translation while scrolling the page.

Escape or a click elsewhere closes the popup. A dismissed selection does not reopen by itself. Disabling Selection translation stops both views while keeping learning preferences.

## Dictionary and card controls

The card includes 3,000 common English dictionary entries that work without a separate download. For other words, the online dictionary can show a result while FluentRead downloads and verifies the full dictionary for later local lookup. The complete file is about 3.9 MB and is cached after downloading. If the download is unavailable, common local entries and the online dictionary remain usable. The dictionary download URL does not include the word you are looking up.

Drag the card by its top or surrounding blank space to move it. Drag an edge or corner to resize it; long text scrolls inside. The next selection opens a new card at its default size near the selected text.

When the target is Chinese or English, the card's language button can change the direction for this result without changing page translation settings. Selection behavior and language preferences are configured under **Selection translation**.

## Optional AI explanations

Enable **AI explanations**, expand **Service & learning preferences**, and select a configured AI service and model. Opening a card does not call AI. Choose an action to request an explanation:

- **Understand** explains meaning, tone and references.
- **Parts of speech & syntax** explains the sentence structure and labels source fragments.
- **Usage** teaches natural expressions and collocations.
- **Practice** provides a short exercise.

Meaning, Grammar, Usage and Practice keep the complete source at the top of the scroll area. Each view starts just below the source so you can read the answer immediately. Scroll up to check the source without expanding anything, or choose View original in More actions. Streaming updates preserve your reading position. Clicking the current tab preserves your position and unsent follow-up.

The compact Grammar tab opens parts-of-speech and syntax analysis. Source fragments appear in order as compact two-line annotations: the original above, with the syntactic role and word class always visible below. This gives an overview without clicking every word. Role summaries quote the first short clause of the supplied explanation; they do not infer new grammar. Click a fragment or use the left/right arrow keys for its meaning and complete role explanation. General word-class explanations expand on demand. A noun may be a subject in one sentence and an object in another. The default grammar prompt requests a compact table that the interface matches to the source in order. Unmatched or incomplete output, and custom formats, remain readable as ordinary text. AI analysis may be wrong; check the original when in doubt.

Completed answers are reused when switching learning actions within the current card. Choose Regenerate in More actions for a new answer, return to the translation, or ask a follow-up. More actions also contains source speech, sentence expansion, saving, reading history and settings. Changing the source, model, language or learning preferences invalidates related cached answers.

## Context and records

Under **Context, learning memory & instructions**, choose the selection alone or allow its paragraph. This does not read the entire page. Learning memory is optional and off by default. Custom prompts are preserved.

Save expressions to the [Learning center](/en/guide/vocabulary-book). Reading conversations stay on this device for 30 days. Viewing records sends no model request. Private windows do not read or save history. See [Data and privacy](/en/guide/privacy).

## Existing preferences

Upgrades preserve services, custom models, actions, context and prompts. Existing standalone cards migrate to the unified feature, including their activation method when ordinary selection translation was disabled. Old settings links still work.

Learning conversations continue to use the browser adaptation of DeepSeek Harness, without requiring a DeepSeek model. [Source and license](https://github.com/FluentRead/FluentRead/blob/main/public/third-party-notices/deepseek-harness-MIT.txt)

## Next steps

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
