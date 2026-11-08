# Mobile and Safari

Choose the installation method for your browser, then translate from its extension menu or the page’s floating button. A desktop extension ZIP cannot be installed directly on an iPhone.

| Environment | Installation | Scope |
| --- | --- | --- |
| Android Edge | Search its extension directory for FluentRead | Availability and permissions depend on browser version and management policy |
| Android Firefox | Extension manager or Mozilla Add-ons | Use the compatible installation option offered on your device |
| Android Via | [Install the standalone script](/en/guide/userscript#via-setup-and-troubleshooting) | Core page and selection translation |
| Safari Userscripts on iPhone, iPad, or Mac | [Install the script](/en/guide/userscript#safari-userscripts-setup-and-troubleshooting) | Core page and selection translation; no extension video subtitles, image OCR, or area translation |
| Native Safari extension | Developer preview below | Source build and Xcode required; no Safari store package yet |

## Install and update

**Android Edge:** install FluentRead from the extension directory, grant the requested permissions, and refresh open pages. If the directory or listing is absent, check your browser version and management policy. After updating, check the installed extension’s details and refresh the page.

**Android Firefox:** use the installation offered by the extension manager or [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/). Firefox handles compatible updates. See [Mozilla’s installation instructions](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android).

**Safari Userscripts:** follow the [script setup steps](/en/guide/userscript#safari-userscripts-setup-and-troubleshooting) to enable the manager, allow site access, and install the script. Keep one FluentRead copy enabled. Replace manually imported files yourself and refresh the manager’s file list.

## Use on a phone

1. Open a regular webpage and translate from the extension menu or floating button. Use the same entry to restore the original. After changing language or service, restore before translating again.
2. For selection translation, long-press text, adjust the selection handles, and tap the translation icon. The system copy menu may also appear; keep the selection active.
3. To change services, open the service list in the extension panel, search for a service or model, and select it.

Browser internal pages and extension stores cannot be translated. Under **Selection translation → More settings**, **Return to the original page** returns to your reading tab. It shows a message if that tab has closed.

If the system reloads a page after rotation or returning from the background, wait for recovery and translate again. Reports should include the OS, browser, extension or script versions, URL, and whether system video fullscreen was active.

## Video subtitles

Subtitles require the extension build. Enable captions in YouTube’s web player first. Turning subtitle translation off hides its player entry; enable it again under **Settings → Video subtitle translation** in the extension panel.

iOS system video fullscreen does not display webpage overlays. The native preview prepares a system caption track named “FluentRead”; select it yourself in the system caption menu. The system controls its appearance, and new translations may be delayed while the page is suspended. If the track is unavailable, leave system fullscreen for inline playback. This path still needs iPhone and iPad device verification.

## Native Safari developer preview

The native extension targets Safari/iOS 26+ and runs independently of Userscripts. Avoid enabling both on the same page. It remains a developer preview.

Grant **website access** and **translation-service access** separately. Free translation tries authorized services only: allowing one service starts translation, while declining does not prompt for another automatically. Add services individually in full settings without first granting all websites.

Chrome’s built-in translation, image OCR, and area capture are unavailable, along with some local processing, speech playback, and Chrome-only Google Drive sign-in. Each online service still needs runtime verification.

<details class="guide-details">
<summary>Build and install the source preview</summary>

Use macOS, full Xcode, and the Node.js and pnpm versions specified in `.nvmrc` and `package.json`. Run these commands from the repository root.

```sh
pnpm safari:check
pnpm build:safari
pnpm safari:verify
pnpm safari:package --bundle-id org.example.FluentRead
```

Replace the example bundle ID with your own. The default Xcode project directory is `.output/safari-xcode`. Existing directories are preserved; add `--project-location .output/safari-xcode-next` for another package.

Open the project in Xcode, select the platform, development team, and device, then build and install. Physical devices require signing. On iPhone or iPad, enable it under **Settings → Apps → Safari → Extensions → FluentRead** and grant access. On Mac, use Safari’s extension settings.

Building and packaging do not sign, publish, or update an installed app. If Xcode reports a missing simulator runtime, install it under **Xcode Settings → Components**.

</details>

## Acceptance limits

Existing checks cover settings, permissions, page translation, and restore in Safari simulators, plus some Android emulator scenarios. They do not replace device checks for installation, updates, touch selection, keyboards, accessibility, fullscreen video, or background recovery. Native Safari remains a developer preview.
