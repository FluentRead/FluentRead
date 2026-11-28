# Mobile & Safari

Pick the right installation path for your phone, tablet, or Mac. Note that desktop extension ZIP files **cannot** be installed directly on iPhone.

<DocDiagram kind="platform-matrix" en />

## Choose your installation method

| Environment | How to install | Capability scope |
| --- | --- | --- |
| **Android Edge** | Search **FluentRead** in Edge’s extension store | Features & permissions depend on browser version and policies |
| **Android Firefox** | Add-on manager or [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) | Core extension features managed by Firefox ([Mozilla help](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android)) |
| **Android Via** | [Install standalone userscript](/en/guide/userscript#via-setup-and-troubleshooting) | Core bilingual webpage & selection translation |
| **Safari Userscripts (iOS / iPadOS / macOS)** | [Install userscript](/en/guide/userscript#safari-userscripts-setup-and-troubleshooting) | Core webpage & selection translation (no extension captions, OCR, or area mode) |
| **Safari Native Extension (Preview)** | Build from source with Xcode below | Developer preview for Safari/iOS 26+; no App Store package yet |

## Everyday mobile usage

1. Open any regular HTTP(S) webpage and trigger **Translate** from the extension menu or floating ball (use the same control to restore; restore before switching language or provider).
2. **Selection translation:** Long-press to select text, adjust handles, then tap the FluentRead icon (keep the selection active even if the system copy bar appears).
3. **Switching providers:** Search providers or models inside the panel; use **Back to page** under **Selection translation → More settings** to return to your reading tab.
4. If rotating your screen or returning from background reloads the page, wait for reload and translate again.

## Mobile video captions

Video captions require the extension edition: enable native captions in YouTube’s web player first. If you turn captions off, re-enable them under **Settings → Video subtitle translation**.

::: info iOS native fullscreen limitation
iOS native fullscreen players hide webpage overlays. The Safari native preview prepares a system subtitle track named **FluentRead** that you can select manually in the iOS caption menu, or exit fullscreen to view styled web overlays.
:::

## Safari native developer preview

Targets **Safari / iOS 26+** and runs separately from Safari Userscripts—**do not enable both on the same webpage**.

- **Explicit permissions:** Grant webpage access and translation-service host permissions separately; free translation only tries already-authorized hosts and never nags consecutively after a denial.
- **Scope:** Image OCR/translation, area screenshot translation, and in-extension TTS are enabled in preview (pending full physical-device verification). Built-in Chrome translation and Chrome-only Google Drive sync are unavailable.

<details class="guide-details">
<summary>Build and install the Safari preview from source with Xcode</summary>

Requires macOS, full Xcode, and the Node.js / pnpm versions in `.nvmrc` and `package.json`:

```sh
pnpm safari:check
pnpm build:safari
pnpm safari:verify
pnpm safari:package --bundle-id org.example.FluentRead
```

Replace the example bundle ID with your own. Open `.output/safari-xcode` in Xcode (pass `--project-location` for subsequent builds), configure signing, build to your device/simulator, and enable **FluentRead** under Safari Extensions settings.

</details>

## Verification status

Automated checks cover Safari simulator settings, permissions, webpage translation/restore, and Android emulator core flows; full physical-device touch, fullscreen video, and background-resume testing remains ongoing.

## Related guides

- [Userscript installation & troubleshooting](/en/guide/userscript)
- [Offline download & installation (Desktop)](/en/guide/offline-install)
