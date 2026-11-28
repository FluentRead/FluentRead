# Shortcuts & triggers

Translate pages, individual paragraphs, or screen regions instantly from your keyboard. On macOS, `Alt` maps to `Option`.

<DocDiagram kind="shortcuts-board" en />

<GuideVisual kind="shortcuts" en />

## Where to customize shortcuts {#where-to-change-them}

- **Hover & selection triggers:** Open **Hover translation** or **Selection translation** from the popup or Settings.
- **Area translation shortcut:** Edit under **Settings → Image & manga translation → Area translation**.
- **Browser commands** (such as **Open translation window**): Assign in your browser’s extension shortcuts page.

When recording a shortcut, hold `Ctrl`, `Alt/Option`, or `Shift` plus a letter or function key, then confirm. Conflicting shortcuts with other enabled FluentRead features prompt you to choose another combination.

## Section translation & independent profiles {#section-translation-and-extra-profiles}

Enable the section-picker shortcut (`Alt+R` / `Option+R` by default) under **Settings → Translation → Section translation**:

1. Press the shortcut, preview blocks with your cursor, and click or drag across paragraphs to lock.
2. Fine-tune with `↑ / ↓`, confirm with `Enter` (confirming an already-translated section restores it), or exit with `Esc`.

### Up to 8 independent profiles

Hover, page, and section translation each support up to **8 extra profiles** with independent shortcuts, providers, models, languages, and display modes. Enabled extra profiles continue working even if the primary shortcut is turned off. See [Section translation](/en/guide/features#section-translation).

<details class="guide-details">
<summary>Provider & model inheritance in extra profiles</summary>

When a profile follows the default provider, selecting a specific model pins the current provider. Clearing the model restores that provider’s default; select **Follow default** to track the global webpage provider again.

</details>

## Two-point selection (hands-free multi-line highlight) {#two-point-selection}

Enable **Two-point selection** under **Settings → Selection translation → Activation and display**:

1. Press `Alt+Shift+S` (`Option+Shift+S` on Mac).
2. Click the **start** and then the **end** of the passage—works across lines and in reverse without holding the mouse button.
3. The second click creates a standard browser selection and opens your configured selection entry.

- Press `Esc`, re-press the shortcut, or leave the page to cancel; clicking links, buttons, or inputs exits and preserves normal webpage interaction.
- Up to **4,096 characters** per selection; only one picking mode (two-point, section, or area) can be active at a time.

<details class="guide-details">
<summary>Paragraph copy options & selection activation styles</summary>

### Paragraph copy (`Alt+C` / `Option+C`)

Configure under **Settings → Translation → Paragraph copy** (automatically yields inside inputs; `Ctrl+C` stays standard copy):

| Copy mode | Behavior |
| --- | --- |
| **Follow page display (default)** | Copies bilingual or translation-only when translated, or original otherwise |
| **Original** | Always copies the source paragraph |
| **Translation** | Copies original with a notice if untranslated |
| **Original and translation** | Copies both in your configured bilingual order |

### Selection activation styles

Choose **Show icon (default)**, **Dot**, **Direct popup**, **Hover icon**, **Shortcut**, or **Context menu only** (keep **Settings → Context menu** enabled when using Context menu only).

</details>

## Shortcut not responding or conflicting? {#not-working-or-conflicting}

1. Verify the feature is enabled on a regular webpage (browser settings and store pages block extensions).
2. Check whether focus is inside an input box or active IME composition—shortcuts intentionally yield while typing.
3. Check for clashes with browser, OS, or website shortcuts (on macOS, `Option` combos match physical keys).

## Related guides

- [Hover translation](/en/guide/hover-translation)
- [Selection translation](/en/guide/deepseek-harness)
- [Page & section translation](/en/guide/webpage-translation)
- [Area translation](/en/guide/area-translation)
