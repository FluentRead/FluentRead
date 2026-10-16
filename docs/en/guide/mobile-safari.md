# Mobile and Safari

On a phone, start translation from the browser extension menu or the page's floating ball. Check the installation options offered by your browser first. A desktop ZIP cannot be installed directly on an iPhone.

| Environment | Installation | Current boundary |
| --- | --- | --- |
| Android Edge | Search for FluentRead in the browser's extension directory | Available extensions and permissions depend on the browser version and management policy |
| Android Firefox | Firefox extension manager or Mozilla Add-ons | Mozilla lists Android support; the development build passed emulator page translation and restore, with physical-device acceptance pending |
| Android Via or another script environment | [Userscript guide](/en/guide/userscript) | Via requires the standalone source build; existing Android 13 emulator evidence does not cover physical devices |
| Safari Userscripts on iPhone, iPad or Mac | [Userscript guide](/en/guide/userscript) | Core page and selection translation; no extension video subtitles, image OCR or area translation |
| Native Safari Web Extension | Developer preview below | Source build and Xcode packaging for Safari 26+; no installable Safari store release yet |

## Install and update

**Android Edge:** open the browser's extension directory, find FluentRead and review its permissions. Open FluentRead from the extension menu, then refresh articles that were open before installation. If the directory or listing is unavailable, check your browser version and management policy, or use a supported script environment. Desktop unpacked-extension instructions do not apply to phones. Microsoft's [mobile policy documentation](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-mobile-policies) confirms that organizations can disable Android extensions; it does not establish that every mobile version installs every desktop extension. After updating, check the version in extension details and refresh the article.

**Android Firefox:** use the extension manager or the [FluentRead listing on Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/). On 2026-10-15 the listing explicitly marks FluentRead as available for Firefox Android. Use the installation action offered to your device. Firefox manages compatible extension updates. See [Mozilla's installation and permission instructions](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android). The current development build was temporarily loaded through Firefox's official debugging flow on an Android 12 emulator running Firefox 158, where actual public-page translation and restore passed. Store installation, updates and physical Android Firefox testing remain outstanding.

**Safari Userscripts:** install Userscripts, grant access to the site and import the script. Enable only one FluentRead script. Greasy Fork, manually imported standalone builds and a future native Safari app have separate update channels. Replace manually imported files and refresh the manager's file list when updating. A source build does not update an installed script automatically. See the [userscript guide](/en/guide/userscript) for existing steps and verification limits.

## Use on a phone

- **Page translation:** open a normal HTTP(S) article and translate from the extension menu or floating ball. Restore from the same entry. After changing language or service, restore before translating again. Browser internal pages and extension stores cannot be injected.
- **Selection:** enable selection translation, long-press text, adjust the system selection handles and tap the translation icon. The system copy menu may also appear. Keep the selection active; touch-only devices do not need a hover shortcut.
- **Choose a service:** open the translation-service entry in the panel, then search for a service or model. The drawer follows the visible area when the software keyboard opens, keeping search, clear, back and close available while the list scrolls inside it. The backdrop continues to cover the page and intercept clicks on settings behind it. Clearing the query or going back preserves the selected default service.
- **Subtitles:** this path requires the extension build. Enable captions in the YouTube web player before using video translation. iOS native video fullscreen does not include page DOM overlays. The native extension prepares a “FluentRead” system subtitle track using the available source timeline and cached translations. After entering system fullscreen, choose it from the system caption menu. Entering fullscreen or updating translations does not replace the system’s current caption selection. The system player controls its appearance, and new translations may be delayed while the page is suspended. If the track is unavailable or switching fails, return to inline bilingual playback. This bridge still needs iPhone/iPad device verification.

Overlays should follow the visible area after rotation, keyboard changes and returning from the background. If the OS reloads the page, wait for the page and extension to recover before translating again. Report the OS, browser, extension or script version, page URL and whether system video fullscreen was active.

## Native Safari developer preview

The native extension and Userscripts run independently; avoid enabling both on the same page. The native target shares WXT, Vue, TypeScript and the existing business modules.

Safari/iOS 26+ is required because existing DNR rules scope requests through `initiatorDomains` and `requestMethods`. [MDN's official compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/declarativeNetRequest.json) records Safari 26 support for both conditions. These isolation conditions must remain in place. The manifest excludes Chromium Offscreen, Chrome OAuth identity and Firefox identity fields. Declaring website access in the manifest does not grant it: users still approve site access in Safari.

The current capability contract disables Chrome's built-in translator, OCR/image translation, screenshot area translation and processing or extension audio playback that requires the shared extension DOM container. Selection speech has an existing page-audio fallback, subject to gesture and audio policies. Chrome-only Google Drive authentication stays unavailable. Header adaptation and free translation providers require individual Safari runtime checks; manifest validation cannot establish network availability.

The native Safari free pool uses only authorized services. On the first translation from the extension panel, allow one service in Safari's permission prompt. Declining does not request another service automatically. To authorize more, use each service's Allow action in the full settings. Page access and service-domain access are separate; you can allow a day without granting all websites. Your enabled-service order and routing preferences remain intact, and restoring existing translations does not require new service access. This policy prevents automatic fallback from queuing domain prompts; it does not mean every public CORS endpoint technically requires a grant. Fixed and custom services keep their existing flow.

Preference changes, cache clearing, vocabulary updates and personal corrections are synchronized with pages where FluentRead is already running. Website and service access remain separate and are granted as needed for translation; synchronizing these changes does not require access to all websites.

<details class="guide-details">
<summary>Maintainers: generate and check an unsigned Xcode wrapper</summary>

Use macOS, full Xcode, Node 20+ and the repository's locked pnpm dependencies. The target uses WXT 0.20.18's Safari MV2 build. An explicit UTF-8 `safari-background.html` loads the existing script and retains `persistent: false`, following [Apple's iOS lifecycle requirement](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari). Keep this page entry: the generated `background.scripts` page prevented initial language settings from saving in the Chinese iOS 26.2 Simulator; a comparison using the same App confirmed the explicit-page fix.

Run these commands from the repository root:

```sh
pnpm safari:check
pnpm build:safari
pnpm safari:verify
pnpm safari:package --bundle-id org.example.FluentRead
```

Replace the example bundle identifier with your own. Set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` before a command when needed. The build uses the resource-safe runner; packaging does not rebuild the extension.

`safari:check` reads tool and Xcode versions and SDK path availability. An SDK path does not establish an installed simulator runtime or connected device. `safari:verify` checks the final manifest, UTF-8 background page, background build target, content scripts and referenced files under `.output/safari-mv2`, including MV2 `optional_permissions` matching the 21 exact free-service origins. The shared catalog covers initialization and internal fallback endpoints and must be updated when provider origins change. Packaging selects `safari-web-extension-packager`, falling back to `safari-web-extension-converter` on older Xcode. It copies resources into macOS/iOS projects without opening Xcode, signing or uploading.

The container app shows Chinese or English enablement steps based on the system language and supports dark mode. On iPhone, open Settings → Apps → Safari → Extensions → FluentRead, then grant access to the sites you want to translate. Simulator and no-team builds show manual steps. On physical iOS 26.2+ devices with an actual Xcode development team, the app also offers Apple's public settings shortcut; that physical-device shortcut still needs acceptance. The Mac button opens Safari extension settings. Packaging does not configure a development team.

Packaging raises Apple's template deployment targets to iOS 26 and macOS 14, retaining any higher existing target. Macs still need Safari 26+. These OS requirements follow [Apple's Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes).

The default destination is `.output/safari-xcode`. Existing directories are preserved and rejected. Rebuild before updating, then use a fresh destination:

```sh
pnpm safari:package --bundle-id org.example.FluentRead --project-location .output/safari-xcode-next
```

Use `--platform macos` or `--platform ios` for one platform. The generated `fluentread-package-report.json` records project paths, manifest and complete-resource hashes, source version and unsigned status. Copied resources are compared against the source build; an unchanged manifest cannot establish an unchanged JavaScript build. This is not a device acceptance report. Copied resources do not follow later changes in the original build directory.

For unsigned compile checks, use the actual project path from the report. Confirm scheme names with `xcodebuild -list -project PATH` first:

```sh
node scripts/testing/run-resource-safe.mjs -- xcodebuild -jobs 1 -project "PROJECT_PATH_FROM_REPORT" -scheme "FluentRead (macOS)" -destination 'generic/platform=macOS' -derivedDataPath .output/safari-derived-macos CODE_SIGNING_ALLOWED=NO build
node scripts/testing/run-resource-safe.mjs -- xcodebuild -jobs 1 -project "PROJECT_PATH_FROM_REPORT" -scheme "FluentRead (iOS)" -destination 'generic/platform=iOS Simulator' -derivedDataPath .output/safari-derived-ios CODE_SIGNING_ALLOWED=NO build
```

Local macOS use requires installing the containing app, enabling the extension and granting website access through the Xcode/Safari development workflow. iPhone/iPad testing needs an available simulator or connected device and the required development signing. Unsigned compilation does not produce a physical-device installation. Distribution and updates use the containing app channel under [Apple's Safari extension distribution process](https://developer.apple.com/safari/extensions/). This task does not sign, submit to TestFlight/App Store or apply for an account.

If Xcode cannot find an iOS Simulator destination and reports that iOS 26.2 is not installed, install the required component under Xcode Settings → Components. Existing SDK paths do not prevent a direct target/SDK build from failing with `No available simulator runtimes` during asset processing. Removing the destination does not establish a complete app build. The script does not download platforms or create devices. `CODE_SIGNING_ALLOWED=NO` disables developer signing; the macOS linker can still emit a certificate-free ad-hoc Mach-O marker without a team identity. This does not produce a distribution-signed app.

</details>

## Acceptance limits

On 2026-10-15, production Safari resources were validated and packaged with Xcode 26.2, and the universal macOS app compiled. Initial iOS builds failed because no runtime was available. After installing the iOS 26.2 (23C52) runtime, both the complete Simulator app and iPhoneOS arm64 app compiled with developer signing disabled. On a dedicated iPhone simulator, the formal app was installed, the extension enabled for one site, settings retained, and three public sample paragraphs translated. The authorized-services-only policy fixed the queued permission prompts. A fresh task simulator passed zero-grant idle behavior, denial and retry, a single service grant, and translation, restore, retranslation and actual reload of three sample paragraphs without further provider prompts. Native selection-menu interaction, complete touch behavior and video paths remain separate acceptance items. Page access and translation-service domain access are separate; granting all websites is not required. The iPhoneOS artifact still requires signing before physical-device installation.

Packaging warns about `world`, `match_about_blank` and `open_in_tab`, although [MDN's official compatibility data](https://github.com/mdn/browser-compat-data/tree/main/webextensions/manifest) records support before the minimum Safari 26 version (options always open in a separate tab). Warnings remain in the evidence; packaging cannot establish runtime compatibility. Manifest checks and narrow desktop viewport tests establish only their stated scope. These checks still require real devices:

- Safari macOS and iPhone/iPad installation, enablement, permissions, configuration retention across updates, disablement and removal.
- Touch selection and system menus, keyboards, rotation, safe areas, larger system text and assistive technology.
- YouTube inline/native fullscreen changes, background suspension, live translation providers and audio.
- Android Edge/Firefox installation, updates, memory reclamation and the three translation paths.

Native Safari remains a developer preview until these checks have evidence.
