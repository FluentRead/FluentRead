# Built-in browser translation

FluentRead can translate on your device using the Translator API in desktop Chrome 138+ and Edge 148+. The first language pack download requires an internet connection. Once downloaded, the pack works offline. Availability depends on the browser version, device, language pair, and managed policies.

Firefox provides on-device translation for pages and selected text through its browser menus. Its translation engine is currently unavailable to extensions. For offline translation in FluentRead on Firefox, choose “Local model translation”.

## Prepare a language pack

1. Open **Settings → Translation services → Built-in browser translation** to see the language pair and pack status.
2. Click **Prepare language pack** to download the required models and verify the pair. If the pack is already downloaded, click **Check language pack**.
3. When the status shows **Ready**, you can **Set as default** and return to the page to translate. When a new pair needs a language pack, follow the preparation prompt.

Existing “Chrome built-in AI translation” settings appear under “Built-in browser translation”.

## Check availability

Settings indicates whether the browser exposes the API. If a pair is unavailable, check the browser’s language support, internet connection, and policies. You can also switch to another translation service.

- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api) · [Chrome model diagnostics](https://developer.chrome.com/docs/ai/debug-built-in-model)
- [Microsoft Edge Translator API](https://learn.microsoft.com/microsoft-edge/web-platform/translator-api)
- [Firefox on-device translation help](https://support.mozilla.org/kb/website-translation)
