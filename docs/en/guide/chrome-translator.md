# Built-in browser translation

FluentRead can use the native Translator API built into desktop **Chrome 138+** and **Edge 148+** to translate webpages directly on your device—no API key required, and offline after language packs download. Availability depends on browser version, device, language pair, and enterprise policies.

<GuideVisual kind="chrome-local" en />

## Prepare & enable in 3 steps

1. Open **Settings → Translation providers → Built-in browser translation** to inspect the current language pair and pack status (older configs labeled “Chrome built-in AI translation” migrate automatically).
2. Click **Prepare language pack** to download and verify the model for that language pair, or **Check language pack** if already installed.
3. Once marked **Ready**, click **Set as default translation provider** and return to your webpage. Repeat when adding new language pairs.

## Note for Firefox users

Firefox includes its own built-in on-device translation in the browser menu, but does not yet expose a translation API to extensions. To translate offline with FluentRead in Firefox, use [Built-in local models](/en/config/translation-engines#local-model-translation) or local Ollama.

## Availability & browser diagnostics

Settings immediately indicates whether your browser exposes the Translator API. If a language pair is unavailable, check browser version, initial download network, or managed policies—or switch to another provider anytime.

- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api) · [Debug Chrome built-in models](https://developer.chrome.com/docs/ai/debug-built-in-model)
- [Microsoft Edge Translator API](https://learn.microsoft.com/microsoft-edge/web-platform/translator-api)
- [Firefox local translation help](https://support.mozilla.org/kb/website-translation)

## Related guides

- [Translation providers & local models](/en/config/translation-engines)
- [Privacy policy](/en/guide/privacy)
