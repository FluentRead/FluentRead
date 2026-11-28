# Userscript

When browser extensions are unavailable, run FluentRead’s core webpage and selection translation via **Tampermonkey**, **Violentmonkey**, **Via**, or **Safari Userscripts**.

<GuideVisual kind="userscript" en />

<DocDiagram kind="platform-matrix" en />

## Quick installation

1. Install and enable a compatible userscript manager.
2. Open the [FluentRead Greasy Fork page](https://greasyfork.org/zh-CN/scripts/482986) and confirm installation.
3. Keep only **one** FluentRead script enabled, refresh a regular HTTP(S) page, and use the floating ball to translate or open settings.

::: tip Chromium script execution permissions
Tampermonkey on Chromium browsers (including Edge Android) may require enabling user-script execution permissions per [Tampermonkey FAQ Q209](https://www.tampermonkey.net/faq.php?q=Q209).
:::

## Build from source

Install dependencies in the repository root and choose the build matching your manager:

| Command | Output file | Best for |
| --- | --- | --- |
| `pnpm test:userscript:standalone` | `.output/userscript-standalone/fluent-read.user.js` | **Standalone (Required for Via):** bundles dependencies offline and includes the full Settings Center |
| `pnpm test:userscript` | `.output/userscript/fluent-read.user.js` | Compact build loading dependencies from jsDelivr with compact settings |
| `pnpm build:userscript:greasyfork` | `.output/userscript-greasyfork/fluent-read.user.js` | Greasy Fork distribution build loading external dependencies |

## Via setup and troubleshooting {#via-setup-and-troubleshooting}

1. Build the standalone script above.
2. Open Via **Settings → Scripts → + → Import script**, pick `.user.js`, enable it, and disable other FluentRead copies.
3. Open a regular webpage; if the floating ball is missing, verify the script toggle, URL scheme, and installed version.

## Safari Userscripts setup and troubleshooting {#safari-userscripts-setup-and-troubleshooting}

1. Install **Userscripts** from the App Store and enable it in Safari extension settings with site permissions.
2. Install from Greasy Fork, or place your local `.user.js` in the Userscripts directory and open the popup to refresh the file list.
3. Confirm **Enable Injection** is on, refresh the page, and open FluentRead settings from the floating ball (Safari Userscripts has no script menu commands).
4. Grant both page-access and translation-provider domain permissions when prompted. See [Userscripts docs](https://github.com/quoid/userscripts/tree/release/4.x.x).

## Capabilities & privacy

- **Included:** Bilingual webpage translation & restore, selection and hover translation, plus input translation, paragraph copy, and read-aloud where supported by the manager, with free, cloud, AI, or custom providers.
- **Not included:** Image/manga OCR, area translation, built-in browser translation, video captions, writing assistant, translation statistics/AI usage, and extension context-menu/popup layout controls.
- **Storage & locales:** Settings stay in manager private storage. Chinese and English UI ship inside the script; JA/KO/FR/RU/ES fetch once from jsDelivr/GitHub and cache locally (requests never include page text or keys).

## Related guides

- [Mobile & Safari](/en/guide/mobile-safari)
- [Privacy policy](/en/guide/privacy)
