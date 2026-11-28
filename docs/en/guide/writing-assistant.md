# Writing assistant

Draft or improve replies beside supported editors on Gmail, GitHub, Outlook, X, Reddit, LinkedIn, Slack, Discord, and Notion — or press the universal shortcut inside any editable field on any website. Review the result, insert it, then decide when to send.

<GuideVisual kind="writing" en />

## Before you start

Open **Settings → Writing assistant**, enable it and choose an AI service and model. Configure missing details under [Translation providers](/en/config/translation-engines). Save your output language, reference language, length, tone and universal shortcut in settings, or adjust them for the current draft.

## Supported websites and triggers

### First-class platforms (native action-row entry)

On supported collaboration platforms, the writing entry appears beside the native Send / Post / Comment button without floating over your content:

- **Email**: Gmail (`mail.google.com`), Outlook (`outlook.live.com`, `outlook.office.com`, `outlook.office365.com`)
- **Developer collaboration**: GitHub (new issues, Issue/PR replies)
- **Social & communities**: X (`x.com`, `twitter.com`), Reddit (`reddit.com`, `old.reddit.com`, `sh.reddit.com`), LinkedIn (`linkedin.com`)
- **Team chat & docs**: Slack (`app.slack.com`), Discord (`discord.com`), Notion (`notion.so`)

### Any website (universal shortcut on demand)

On all other regular HTTP/HTTPS websites, Writing assistant **never** injects floating buttons on inputs, keeping pages clutter-free. Focus any `<textarea>`, plain text `<input>`, or `contenteditable` editor and press your shortcut (default `Alt+Shift+W`, customizable or toggleable in **Settings → Writing assistant**) to open the assistant on demand with your current draft and bounded surrounding context.

## Draft a reply

1. Select the writing entry beside a supported editor, or focus any editable field on any website and press the writing shortcut.
2. Improve an existing draft, or start from the current email, thread, tweet, chat messages, or surrounding page reference. For a new email without context, enter the recipient, purpose and key points first.
3. Review names, facts and tone after generation. Add instructions to refine the draft if needed.
4. Select **Insert reply** to place it in the editor, or **Copy reply** to paste it yourself.
5. Check and send from the original website. The assistant does not send emails, messages, or comments automatically.

If the original editor changes during generation, check its new content before inserting. Editors containing links, attachments, complex formatting, or managed by rich-text frameworks (such as Slate, ProseMirror, or Lexical) automatically offer a safe copy fallback to protect editor state.

## Bilingual replies

Choose different output and reference languages, then wait for the matching reference translation to finish. **Insert reply** inserts the main text; **Insert bilingual reply** in its menu inserts the main text followed by the reference translation.

GitHub, Reddit, Discord, and Notion keep Markdown formatting; other platforms and generic editors output plain text by default.

<details class="guide-details">
<summary>Improve a draft, hide the panel or stop generation</summary>

## Improve an existing draft

Write in the reply editor before opening the assistant, then adjust the language, length or tone. Change the reference content to start a new draft.

## Reference text and stopping

Check the draft and visible discussion, email, or page reference in **Reference content** before generating. Optional learning memory follows your saved preference and is not read in private windows.

Stop generation, close the panel or leave the page to cancel the request; generated text stays available. Clicking outside temporarily hides the panel. Reopen the entry for the same editor to review the draft and results. If you edit the original, change editors or navigate away, the assistant reads the current content again.

Drafts and reference content remain within this page session.

</details>

<details class="guide-details">
<summary>Adjust or hide the entry and shortcut</summary>

## Adjust or hide the entry and shortcut

The entry menu can close it for this session, disable it on the current site or turn off the feature. Restore disabled sites and customize or disable the universal shortcut under **Settings → Writing assistant**. Saved provider and style preferences are kept. Disabling a site disables both inline entries and the shortcut on that site.

</details>

## Data

Generating or revising sends the necessary reference text, draft, instructions and any permitted learning memory to your selected AI provider. See [Privacy policy](/en/guide/privacy).

## Related guides

- [Input translation](/en/guide/input-translation)
- [AI provider setup](/en/config/translation-engines)
