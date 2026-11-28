# Input translation

Write your message in a chat, email or other webpage, then translate it into the language you need. Replace the original or keep both languages. FluentRead does not send the reply for you.

<GuideVisual kind="input" en />

## Set up the feature

1. Open **Settings → Translation → Input translation** and enable it.
2. Choose the target language, trigger and output mode. Triggers support pressing **Space, equals or hyphen three times** or a **Custom shortcut** (a modifier combination or function key F1–F12). The provider follows page translation unless you choose a separate one.
3. Write in the input field, then press your chosen triple-key trigger or custom shortcut. Wait for the translation to appear. Existing **Ctrl+Enter** preferences also work.

Settings save automatically. Changing a language or provider does not enable the feature. Password fields and code editors are excluded.

## Keep both languages

| Output | Result |
| --- | --- |
| Replace original (default) | Replace the input with the translation |
| Original first | Keep the original and append the translation on a new line |
| Translation first | Put the translation before the original |

Bilingual output needs an input that supports multiple lines. A single-line input keeps the original and explains the limitation. Supported rich-text editors preserve formatting such as paragraphs, bold text and links where possible.

## Cancel or restore

Press **Esc** or select **Cancel** while translating. Editing also cancels the request. Leaving a rich-text editor prevents a late result from pulling focus back.

After translation, select **Restore original** before editing again. Rich-text restoration recovers the text; use the editor's Undo to recover formatting such as links and mentions. If automatic insertion fails, copy the translation from the status message and paste it yourself.

Select **Retry** after a failure. Old results cannot overwrite later edits, and characters inserted by the trigger are removed from the original.

<details class="guide-details">
<summary>Press speed and AI prompts</summary>

## Translate what you type

**Press speed** sets the longest gap between consecutive presses: 1,000 milliseconds by default, adjustable from 200 to 2,000. Shorten it if you trigger translation accidentally; lengthen it if triple presses are difficult. Holding a key and input-method composition do not count. Triggering the same content again while it is being translated keeps the current request.

## AI prompts

For a provider that supports prompts, set the tone or translation requirements. An empty model uses the provider's default. The prompt uses <code v-pre>{{origin}}</code> for the original text and <code v-pre>{{to}}</code> for the target language.

An empty prompt uses the built-in default. Select **Start from the default prompt** to edit it; restoring the default affects only this prompt.

</details>

## Related guides

- [Writing assistant](/en/guide/writing-assistant)
- [Translation providers](/en/config/translation-engines)
- [Shortcuts & triggers](/en/guide/custom-hotkey)
