# Settings overview

Click the gear icon in the extension popup to open full settings. Use **global search** at the top left (for example, search “target language”, “shortcut”, or “menu layout”) to jump straight to any control. Most edits save automatically.

<GuideVisual kind="settings" en />

## Find common settings fast

| Goal | Where to go |
| --- | --- |
| Change target language, default provider, or master switch | **General** |
| Assign separate providers for web, selection, docs & video | **General → Service assignments** or [Translation providers](/en/config/translation-engines) |
| Redact or block sensitive text locally before sending | **Advanced →** [Translation privacy shield](/en/config/privacy-protection) |
| Customize skins, fonts, translation styles & sentence highlight | **Appearance →** [Appearance & reading aids](/en/config/appearance) |
| Reorder or hide popup cards | **Appearance → Menu layout** |
| Auto-translate, translation-only, or disable per domain | **Tools & learning →** [Site rules](/en/config/site-adaptation) |
| Export local backup, inspect snapshots, or set up cloud sync | [Backup & sync](/en/config/backup-sync) |

<figure class="doc-figure"><a href="/screenshots/ui/en-US/settings-general.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/ui/en-US/settings-general.webp" width="2560" height="1600" alt="FluentRead general settings for language, service, and translation mode" loading="lazy" /></a><figcaption>Start by setting your target language and default provider, then fine-tune individual features.</figcaption></figure>

## Master switch & per-feature provider routing

- **Enable extension (Master switch):** Located in **General**. Turning it off halts and cancels active requests across webpages, videos, documents, Translation Center, and Writing Assistant while preserving completed document translations for editing/export.
- **Editing credentials ≠ switching default:** Clicking a service in **Translation providers** only edits its credentials and model; click **Set as default translation provider** to switch your default webpage engine, or assign engines independently under **Service assignments**.

## Excluded languages

Select languages to skip under **Translation → Excluded languages** (Simplified and Traditional Chinese can be set separately).

- Applies to automatic and manual full-page translation, hover translation, and page titles (other languages on mixed pages still translate).
- Does not restrict selection, input, document, image, or subtitle translation; restore and re-translate after changes.

## Skins, interface fonts & menu layout

- **Popup skins & themes:** Switch Light/Dark mode under **Appearance** and choose from 12 curated Popup skins across Signature, Studio, and Editorial series.
- **Menu layout:** Drag or use arrow controls to reorder popup cards and hide unused entries (hiding an entry never disables the feature itself).
- **Interface fonts:** Defaults to system font; downloaded font packs cache offline and can be cleared individually anytime.

## Translation cache, analytics & request limits {#request-limits}

- **Translation cache:** Reuses completed segments; clearing it never deletes vocabulary collections and finishes asynchronously even if you leave the page.
- **Statistics & AI usage:** Monitor [request latency & cache hits](/en/guide/translation-stats) and [AI token usage](/en/guide/model-usage).

If a provider reports rate limiting, lower concurrency or rate under **Advanced → Request limits**:

| Setting | Default | Notes |
| --- | --- | --- |
| **Concurrent requests** | `10` | Excess requests queue cleanly |
| **Max requests per second** | `10` | Set to `0` for unlimited |
| **Max requests per minute** | `250` | Set to `0` for unlimited |
| **AI request timeout** | `120 s` | Tunable `10–600 s` for slower reasoning models |

You can also set overrides per **provider** or per **model** under **Translation providers → Request limits** (model caps still respect their parent provider cap).

## Related guides

- [Translation providers](/en/config/translation-engines)
- [Appearance & reading aids](/en/config/appearance)
- [Backup & sync](/en/config/backup-sync)
