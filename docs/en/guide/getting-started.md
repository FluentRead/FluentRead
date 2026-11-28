# Quick start

Install FluentRead, pin the toolbar icon, and pick your target language—no account required. You can translate your first webpage in under 3 minutes.

## Install {#install}

Install from your browser’s official extension store:

<BrowserInstall en />

- **Store unavailable?** Follow [offline download & installation](/en/guide/offline-install) to install the official ZIP package manually.
- **Mobile & other apps:** See guides for [Mobile & Safari](/en/guide/mobile-safari), [Userscript](/en/guide/userscript), [Thunderbird](/en/guide/thunderbird), and [Zotero](/en/guide/zotero).

::: tip Refresh existing tabs after installing
Reload webpages that were already open before installing FluentRead. Browser settings pages and extension stores are restricted by the browser and cannot be translated.
:::

## Pin the extension

In Chrome, click the puzzle-shaped **Extensions** button beside the address bar, locate **FluentRead**, and click its pin icon so the menu is always one click away.

Hover over the toolbar icon to see a quick summary of page and selection translation in your browser’s language.

<details class="guide-details">
<summary>See where to pin the icon</summary>

<GuideVisual kind="pin" en />

Other browsers may place the pin control elsewhere in their extensions menu.

</details>

## Translate your first webpage

1. Open an article in another language, such as news, docs, or a blog post.
2. Click FluentRead in the toolbar. On first use, pick your **interface language** and click **Confirm**.
3. Choose your **target language**. Keep **Auto-detect** for source language and **Free translation services** as the provider (no API key needed).
4. Click **Translate**. Bilingual translations appear below each paragraph as you scroll.
5. Click **Restore** in the menu anytime to return to the original page.

<GuideVisual kind="first-translation" en />

::: info Interface language vs. target language
The **interface language** controls buttons and settings menus, while the **target language** controls what webpages are translated into. The default popup keeps controls in consistent positions; hover truncated labels to read them in full. Site rules show a green dot when enabled and gray when off—click the row to toggle.
:::

## Pick the right translation mode

Beyond full-page translation, FluentRead includes section, hover, and selection modes. Switch tabs below to compare triggers and use cases:

<DocDiagram kind="webpage-modes" en />

## One-click translation & quick entries

- **Click toolbar icon to translate directly:** Under **Settings → General → Page helpers**, set **Toolbar icon click action** to **Translate / Show original**. Clicking the icon then toggles translation directly, while right-clicking the icon and choosing **Open quick panel** still opens the menu (even if webpage context menus are off).
- **Floating ball:** Enable it under **Settings → Translation → Floating ball** for one-click page translation and quick panel access via its gear button.
- **Keyboard shortcuts:** Press `Alt+T` (`Option+T` on Mac) for full-page toggle or hover a paragraph and press `Control`. See [Shortcuts & triggers](/en/guide/custom-hotkey).

<span id="translate-selected-text"></span>
<span id="translate-a-paragraph"></span>
<span id="troubleshooting"></span>

## Common problems

| Issue | Quick fix |
| --- | --- |
| Nothing happens on click | Confirm the extension is enabled and refresh a regular HTTP(S) page (browser internal pages are restricted) |
| Provider busy or timed out | Retry shortly or switch providers in [Translation providers](/en/config/translation-engines) |
| Language or provider change didn’t apply | Click **Restore** to return to original text, then translate again |

For more troubleshooting steps, see [Troubleshooting & FAQ](/en/guide/faq).

## Next steps

- [Page & section translation](/en/guide/webpage-translation): Bilingual vs. translation-only, research papers, and remembered sections
- [Translation providers](/en/config/translation-engines): Connect AI models, cloud APIs, or offline local models
- [Appearance & reading aids](/en/config/appearance): Customize styles, fonts, and bilingual sentence highlighting
- [Feature overview](/en/guide/features): Explore images, documents, video captions, and language learning
