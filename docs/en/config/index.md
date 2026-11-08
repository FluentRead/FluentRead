# Settings

Open full settings with the gear in the extension menu. Use search when you cannot find an option, such as target language, shortcuts, or menu layout. Most changes save automatically.

Desktop settings open with all sidebar groups expanded. Scroll within the sidebar in a short window. On narrow screens, use the category menu at the top.

<GuideVisual kind="settings" en />

## Start with these

| What you want | Where to start |
| --- | --- |
| Change the target language or default service | General settings |
| Adjust translation colors, font size, and display | [Interface style](/en/config/appearance) |
| Reduce accidental hover or selection popups | The relevant feature in Translation settings |
| Always translate a website or leave it alone | [Website rules](/en/config/site-adaptation) |
| Change browsers, back up data, or undo settings changes | [Backup and restore](/en/config/backup-sync) |

<figure class="doc-figure"><a href="/screenshots/ui/en-US/settings-general.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/ui/en-US/settings-general.webp" width="2560" height="1600" alt="FluentRead general settings for language, service, and translation mode" loading="lazy" /></a><figcaption>Choose your target language and default service, then adjust the other tools.</figcaption></figure>

The main switch in **General settings** stops new requests from webpages, video tools, documents, Translation Center, and the writing assistant, and cancels active requests. Completed document translations remain available for editing, copying, and export. Turning it on again keeps your preferences; resume unfinished tasks manually.

## Different tools, different services

Select **Translation service** in the extension menu to see the webpage default and the choices for hover, selection, documents, subtitles, and the reading card. Supported features can follow the default or use their own service. Changes save automatically.

General settings also offers feature assignments. The **Translation services** page configures keys, URLs, and models. Selecting a directory entry only opens its settings; choose **Set as default translation service** to change the webpage default. See [Translation services](/en/config/translation-engines).

## Languages to skip

Under **Translation settings → Languages to skip**, select a language to exclude it; select it again to remove it. Simplified and Traditional Chinese are separate choices. **More languages** opens the full list, and **Clear selection** removes extra exclusions.

This checks individual text in automatic and manual page translation, hover translation, and page titles. Other languages on a mixed page remain translatable; short or uncertain text may still be translated. Selection, input, document, image, and subtitle translation are not controlled by this option. Restore the original and translate again after changing it.

## Appearance and menu layout

Choose a light or dark theme under **Interface style**, adjust [translation styles](/en/config/appearance), or use **Menu layout** to drag sections and shortcut cards. The list also has ordering buttons. Hide unused entries and add them back later.

Hiding an entry changes only the menu. Disable the feature itself to stop image, area, subtitle, or reading-card tools.

**Interface font** uses the system font by default. Choosing an uncached font downloads it for later offline use without installing it on your system. Failed downloads can be retried. **Clear** removes the resources that can be released for that font; clearing the active font returns to the system font.

## Sites and shortcuts

- [Website reading area](/en/config/site-adaptation): missing text, automatic translation, and site exclusions.
- [Shortcuts and triggers](/en/guide/custom-hotkey): page, hover, selection, and area controls.
- [Glossaries](/en/guide/glossary): preferred terms for AI translation.

## Reading aids

Enable bilingual sentence highlighting under **Translation settings → Reading assistance**. Hover over a sentence to see its counterpart. Use the style shortcut to adjust its appearance; see [Appearance and reading aids](/en/config/appearance).

## Backups, cache, and usage

[Export a backup](/en/config/backup-sync) before changing browsers or uninstalling. Backups can contain credentials and saved source text.

Translation cache reuses completed results. Clearing it does not delete learning collections. If the result is not yet confirmed, refresh usage later; leaving the page does not cancel a cleanup already started in the background. See [Translation statistics](/en/guide/translation-stats) for duration and service performance, and [AI usage](/en/guide/model-usage) for model usage.

## Request limits

If a service reports too many requests, lower concurrency and request rates under **Advanced settings → Request limits**.

| Limit | Default |
| --- | --- |
| Concurrent translation requests | 10 |
| Requests per second | 10 |
| Requests per minute | 250 |
| AI translation request timeout | 120 seconds |

Set a per-second or per-minute limit to **0** to remove it. Requests above the limit wait in a queue. A cancelled or timed-out request retains its slot until the underlying request finishes.

For separate limits, open **Translation services → Request limits**:

- **Entire service → Custom** limits all models together, useful for a shared account quota.
- **Current model → Custom** limits the model actually sent. If custom JSON overrides the model, limits apply to that model. Model limits still obey the service total.
- Return to **Use global settings** or **Use service settings** to restore inheritance. Your entered values are retained.

Set **AI translation request timeout** to 10–600 seconds for new AI text, batch, input, subtitle, and Translation Center requests. Slower models may need longer. Image recognition, area translation, and connection checks retain their own deadlines. Retry count and intervals are configured globally.

## Related guides

- [Providers and connections](/en/config/translation-engines)
- [Appearance and reading aids](/en/config/appearance)
- [Backup and sync](/en/config/backup-sync)
