# Website reading area

If text is missing or too much is translated, check the reading area first. Use site preferences to remember how a particular website should behave.

<GuideVisual kind="rules" en />

## Missing content

1. Refresh the page after installing or updating.
2. Scroll down: the default mode translates near your reading position.
3. To include menus and buttons, enable all-node recognition under **Advanced settings → Page recognition**, then restore the original and translate again.
4. For text inside an image or chart, use [area translation](/en/guide/area-translation).

Some sites keep author names, timestamps, votes, and navigation unchanged while translating articles, comments, or product descriptions. If the area you need is still missed, adjust its content rule or report the URL and area.

Explicit topic tags stay in their original language, including `chatgpt` and `rate-limit` on the OpenAI community and standard tag links on other forums and blogs. Full-page and hover translation share this rule, including with **all-node recognition** enabled. Post titles and body text remain translatable.

## Translate every time—or leave it alone

Open **Settings → Tools & learning → Website rules → Site preferences**:

| Preference | Effect |
| --- | --- |
| Always translate | Translate new pages on that website automatically |
| Disable extension | Restore the original and stop the extension on that site; overrides automatic translation |
| Hide floating button | Hide the button while keeping shortcuts and other features available |
| Translation only | Show only translated text on this website; other websites keep the global display mode |

Preferences use the root domain and include its subdomains, without paths or ports. Re-enabling a disabled site restores its other preferences. Removing preferences returns to global defaults. Global automatic translation applies to non-disabled sites and keeps your saved list.

Choose **Translation only** when adding a site, or check it on an existing row. It does not enable automatic translation. Existing translations change display without another request; unchecking it returns to the global mode. **Restore** still returns the original text. A shortcut profile with an explicit display mode keeps its one-time choice. Google Translate supports bilingual display only, so choose another service for translation-only sites.

The extension menu also offers always-translate and disable-site controls. Restoring the current article keeps it original, including when following its table-of-contents links. Always-translate takes effect again on the next article. Turning it off affects future automatic triggers and leaves current translations in place.

## Still wrong?

Content rules select article and protected areas by domain, path, and CSS selector. Effective preview checks saved matching rules and priority without visiting the website. Check the actual page after saving.

If you know webpage structure, follow [Custom site rules](/en/guide/custom-site-rules) and export a backup first. Otherwise, report a public URL, browser version, and a screenshot with private information removed on [GitHub Issues](https://github.com/FluentRead/FluentRead/issues). Explain which areas should translate and which should stay original.

Detailed fields are in the [rule reference](https://github.com/FluentRead/FluentRead/blob/main/docs/maintainers/product-reference/site-adaptation-20260906.md).
