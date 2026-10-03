# Input translation

Write in one language and translate inside the input field. Replace the original or keep both languages for a bilingual reply.

## Try the display

<TranslationDemo en variant="input" />

This example uses fixed text. It does not read your input or call a provider.

## Set up the feature

Open **Settings → Translation → Input translation**, enable it, and choose the target language, trigger, and output mode. Provider settings reuse your existing saved connections; the default follows page translation unless you choose a separate service.

## Translate what you type

Write in a regular input or a supported rich-text editor. Use your configured trigger: three consecutive spaces, equals signs, or hyphens. Existing **Ctrl+Enter** preferences remain supported.

The time between consecutive presses defaults to 1,000 milliseconds and can be adjusted from 200 to 2,000 milliseconds under **Press speed**. Key repeats and input-method composition do not count as triple presses.

## Keep both languages

| Output | Result |
| --- | --- |
| Replace original | The translation replaces the input |
| Original first | Keep the original and append the translation on a new line |
| Translation first | Put the translation before the original |

Bilingual output needs an input that supports multiple lines. In a single-line input, FluentRead preserves the original and explains the limitation. Existing formatting in supported rich-text editors is preserved through their input flow.

## Cancel or restore

Press **Esc** while translating to cancel writing back. If you keep editing, a late result will not overwrite the newer text.

After translation, use **Restore original** in the success message before making another edit. Rich-text restoration restores the text; use the editor's Undo to recover formatting such as links and mentions.

Password fields and code editors are excluded. Translation does not send your reply.

## AI prompts

Choose an AI service and model if you need a particular tone. The optional prompt uses `{{origin}}` for the original input and `{{to}}` for the target language. An empty prompt uses the built-in default. Changing settings does not automatically enable the feature.

## Next steps

- [Writing assistant](/en/guide/writing-assistant)
- [Translation providers](/en/config/translation-engines)
- [Shortcuts & triggers](/en/guide/custom-hotkey)

