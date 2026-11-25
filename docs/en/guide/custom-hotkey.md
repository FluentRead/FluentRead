# Shortcuts and triggers

Translate, restore the original or copy a paragraph with a shortcut. On Mac, Alt is usually labeled Option.

<GuideVisual kind="shortcuts" en />

## Common actions

| Action | Default |
| --- | --- |
| Translate a paragraph | Point at it and press **Control** |
| Translate page / restore original | **Alt+T** |
| Capture an area | Press **Shift+Z** once, then drag |
| Copy the paragraph under the pointer | Point at it and press **Alt+C** |
| Translate part of a page | Click **Section** in the extension menu, or enable **Alt+R** |
| Translate a selection | Enable selection translation, select text and click the nearby icon |
| Select text by clicking its start and end | Enable **Two-point selection** in selection settings, then press **Alt+Shift+S** |

## Change a trigger

Open **Hover translation** or **Selection translation** in the extension menu and enter its settings. Change the area shortcut under **Image translation → Area translation**.

To record a combination, hold Ctrl, Alt/Option or Shift and press a letter or function key, then confirm. A modifier alone does not finish recording. Canceling or leaving the settings section keeps the previous shortcut. Resolve any conflict with another enabled feature before saving.

## Section shortcut profiles

The section shortcut is off by default. Enable it under **Settings → Translation → Section translation**.

1. Use the shortcut and move the pointer to preview a section. Click to lock it, or hold the left mouse button and drag across paragraphs, then release.
2. Adjust the range with **↑/↓** or the toolbar. Press **Enter** or click **Translate selected section** to confirm.
3. Select a translated section and confirm again to restore it. Press **Esc**, right-click or use the same shortcut to exit.

Hover, page and section translation each support up to eight extra profiles with their own provider, model, language and display mode. Enabled extra profiles work when the primary shortcut is off. See [section translation](/en/guide/features#section-translation).

## Two-point selection

Enable **Two-point selection** under **Settings → Selection translation → Activation and display**. Press **Alt+Shift+S**, then click the start and end of the text to select across lines or backward without dragging. The second click leaves a native browser selection; translation follows your existing selection trigger.

Press **Esc**, use the shortcut again or leave the page to cancel. Clicking a link, button or editor ends selection and keeps the normal page action. If you click blank space or the same point twice, follow the retry prompt; an established start point is kept. Choose another end point when prompted about protected content or the 4,096-character limit.

If another feature takes the shortcut, the settings row shows the conflict. Click the key label to change it. Two-point selection does not start inside editable areas. Touch devices keep native long-press selection. Two-point, section and area selection use one selection mode at a time.

<details class="guide-details">
<summary>Paragraph copying and selection entries</summary>

Choose copied content under **Settings → Translation → Paragraph copy**:

| Content | Behavior |
| --- | --- |
| Match what is shown (default) | Follow bilingual or translation-only display; copy the original when untranslated |
| Original text | Always copy the webpage text |
| Translation | Copy the original with a notice if it is not translated yet |
| Original and translation | Copy both, following the translated-text position setting |

A notice shows the copied content and character count. The shortcut stays inactive in editable areas. **Ctrl+C** still copies selected text.

Selection translation supports an icon, dot, direct popup, hover-over-icon, shortcut or **Context menu only**. Context-menu mode hides floating entries. Select text and choose **Translate selected text** in the context menu; keep the menu and selection entry enabled under **Settings → Context menu**.

</details>

<details class="guide-details">
<summary>Providers and models in extra profiles</summary>

Choosing a model while following the default provider also pins the current provider. Clearing the model restores that provider's default model; select **Follow default** to follow the webpage provider again. Changing providers clears the old model.

</details>

## A shortcut does nothing

Check the feature through the extension menu first, then look for a conflict with the browser, input method or website. Some keys intentionally stay inactive in inputs. Browser internal pages and extension stores generally cannot be translated.

Custom combinations match the character produced by the layout used during recording. When Option on Mac produces a special character, the physical key is matched. The browser's extension shortcut page controls only the commands it lists; configure other triggers inside FluentRead.

If a page update removes an entry, select the text again. If it stays missing, report the URL, browser, extension version and trigger method.

## Related guides

- [Hover translation](/en/guide/hover-translation)
- [Selection translation](/en/guide/deepseek-harness)
- [Area translation](/en/guide/area-translation)
