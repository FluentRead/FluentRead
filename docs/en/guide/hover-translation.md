# Hover translation

Point at a paragraph and press **Control** to show its translation below the original. Press again to restore the original.

<GuideVisual kind="hover" en />

## Translate one paragraph

1. Open **Hover translation** in the extension menu and enable the **Default hover shortcut**.
2. Point at a paragraph and press **Control**.
3. Hold the key and move to other paragraphs to translate them. Releasing the key keeps translations already shown.

Hover shortcuts, including the tilde key, let you type in inputs and editable areas or compose text with an input method, even while the pointer rests on a paragraph. A focus change or the start of text composition cancels pending hover translation. Leave the editor and press the shortcut again to resume. Change the key or trigger delay in [Shortcuts & triggers](/en/guide/custom-hotkey). The delay starts when you enter a paragraph; moving within it does not restart the wait. Set it to 0 for an immediate trigger.

## Retry or restart

Click an error indicator to retry, or focus it and press **Enter**. Moving the pointer does not repeatedly retry the same failed paragraph.

Switching tabs, navigating away or scrolling cancels translation that has not started. Move the pointer and press the shortcut again to continue.

<details class="guide-details">
<summary>Paragraph copying and trigger settings</summary>

Press **Alt+C** (Option+C on Mac) to copy the paragraph under the pointer. By default, FluentRead follows the current display: a translated paragraph copies what is currently displayed; an untranslated paragraph copies the original.

Change the shortcut and copied content in **Settings → Translation → Paragraph copy**.

</details>

## Related guides

- [Shortcuts & triggers](/en/guide/custom-hotkey)
- [Translation providers](/en/config/translation-engines)
