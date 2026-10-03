# Use a script manager

If you use Tampermonkey, Violentmonkey, Via, or Safari Userscripts, you can install the FluentRead userscript for core webpage translation. Support depends on your browser and script manager version.

## Install

Open the [FluentRead Greasy Fork page](https://greasyfork.org/en/scripts/482986), follow your script manager’s installation prompts, then open a regular webpage. Confirm that the script is enabled.

The Greasy Fork release may lag behind the GitHub source. Check the version on the installation page and in script settings when reporting a problem. Runtime checks cover Chrome with Violentmonkey and Via 7.3.3 in an Android emulator; Safari Userscripts and Via on a physical device still need testing.

### Build the standalone script from source

To try fixes that have not reached Greasy Fork, install the repository dependencies, run `pnpm test:userscript:standalone`, and import `.output/userscript-standalone/fluent-read.user.js` through your manager's file installation option. **Use this standalone build with Via**: in the Via 7.3.3 emulator test, the slim build's `@require` libraries did not load, so the floating button never started. The standalone build includes Vue, the UI libraries, and the gzip fallback needed by older browsers. It needs no `@require` downloads at installation; translation services and first use of other UI languages still need a network connection. Install either the standalone or slim build to avoid running both.

`pnpm test:userscript` also produces a smaller `.output/userscript/fluent-read.user.js`. Its pinned `@require` dependencies must download during installation. Violentmonkey has sometimes run that build before its dependencies were ready when installed from a file; the standalone build passed an immediate first-page test in an isolated real manager. Neither build is the version currently published on Greasy Fork.

The repository also has a slim build intended for Greasy Fork's source rules. Run `pnpm build:userscript:greasyfork` to produce `.output/userscript-greasyfork/fluent-read.user.js`. Its readable source keeps the translation logic, while third-party libraries, UI text, site rules, and CSS load through `@require` URLs pinned to one Git commit. Installation requires network access, and this build uses the compact settings panel. The source is below Greasy Fork's 2 MB limit; acceptance still requires an actual submission review, and building it does not update the listing. To refresh the resources, run `node scripts/build-userscript-greasyfork.mjs --prepare-resources`, commit the two generated files, then run the normal build to pin both URLs to that commit.

The repository’s **standalone build** opens the same full Options center used by the browser extension. Use the floating button or the script manager menu. Desktop managers with a dedicated active-tab API open it in a new tab at the current site’s URL; Android (including Via) and managers without that API open an isolated overlay on the current page without changing the site’s URL. Language, service, and appearance preferences are kept in the script manager’s private storage. Image translation, area translation, video subtitles, writing assistance, translation statistics, and model usage sections show an unavailable message in the userscript. The right-click menu and extension popup layout controls show an explanation too, so they cannot save settings that have no effect. The **slim build** keeps its compact settings panel. Check the installed version before expecting these changes from the Greasy Fork listing.

The standalone build exceeds [Greasy Fork’s direct publication size and code rules](https://greasyfork.org/en/help/code-rules). For now, install a locally built file through your script manager; a successful repository build does not mean it has been published on Greasy Fork.

## Via setup and troubleshooting

Build the standalone script above, then in Via go to Settings → Scripts → + → Import script and select the generated `.user.js` file. Confirm that it is enabled and reopen a regular HTTP(S) page. **Disable any Greasy Fork or slim copy** to avoid duplicate injection. If the floating button is still missing, report the Via, Android, and script versions and the affected URL.

In an isolated Android 13 emulator running Via 7.3.3, the imported standalone build translated English paragraphs after tapping the floating button, restored the originals, and translated them again. The selected settings theme also survived a refresh. This used a controlled test page and translation response; it is not a physical-device test or proof that public translation services will keep working.

## Safari Userscripts setup and troubleshooting

1. Install Userscripts from the App Store and enable its Safari extension. On iPhone/iPad, go to Settings → Safari → Extensions → Userscripts, allow access to all websites, and choose Always Allow in Safari. On macOS, grant the extension access to the sites you visit.
2. Confirm the scripts directory in the Userscripts app. Recent iPhone/iPad versions normally create a default directory, and macOS can use its default directory too. For the Greasy Fork release, open the installation page above in Safari and use the Userscripts toolbar prompt to save and enable it. To try the standalone build from source, put its `.user.js` file in that scripts directory, then open the Userscripts popup to refresh the file list. Stay online during installation of the slim build while the manager downloads its `@require` UI libraries.
3. In the Userscripts popup, confirm Enable Injection is on and FluentRead is matched and enabled for the current site. Reload a regular HTTP(S) page. Open FluentRead settings from its page floating button; Safari Userscripts does not provide script menu commands.
4. If you added or edited the script directly in its directory, open the Userscripts popup at least once to refresh its file list. If the floating button is still missing, check the script version, site permission, URL match, and whether the required libraries downloaded. Include Safari, system, and Userscripts versions and the affected URL in a report.

These steps follow the [official Userscripts installation and metadata documentation](https://github.com/quoid/userscripts/tree/release/4.x.x). Runtime behavior on Safari still needs device verification.

## What it can do

Translate pages and restore originals; translate selected or hovered text; use supported gestures, input translation, copying, and read-aloud; choose free, cloud, AI, or custom services. Preferences are saved in the script’s own settings; the repository’s standalone build has the full Options center.

For the slim build, the script manager downloads fixed versions of UI libraries from jsDelivr at installation; the standalone build includes them. Chinese and English UI text ships with both. On first use, Japanese, Korean, French, Russian, and Spanish UI text is downloaded from jsDelivr or GitHub and cached in the script manager’s private storage. These resource requests contain no page text or API keys. If you are offline before a language is cached, the UI temporarily falls back to Chinese.

## How it differs from the extension

The script manager and webpage permissions limit available features. Image recognition, area capture, Chrome’s built-in translation, background features, and video subtitles may not be available. Behavior can vary between script managers.

## Data

Configuration stays in the script manager’s private storage. Translation text goes to the service you select. UI libraries and language files come from jsDelivr or GitHub as described above. Keep credentials out of shared screenshots and public feedback; see [Data & privacy](/en/guide/privacy).

## Next steps

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
