# Site rules & reading area

Fix missed article text, automatically translate favorite sites, or disable FluentRead on specific domains using clear, predictable priority rules.

<GuideVisual kind="rules" en />

<DocDiagram kind="site-rules-priority" en />

## Step 1: Fix missed content {#missing-article-text}

1. Refresh the webpage after installing or updating FluentRead.
2. Scroll down—translations run progressively around your viewport by default.
3. To include menus, buttons, and navigation, enable **Recognize all nodes** under **Advanced settings → Page recognition**, restore the page, and translate again.
4. For non-selectable text inside images or charts, use [Image translation](/en/guide/image-translation) or [Area translation](/en/guide/area-translation).

### Built-in site protections

Common platforms include tailored rules so navigation and identifiers stay clean:

- **Topic tags & Discourse badges:** Explicit tags such as `chatgpt`, `rate-limit`, and `API` stay untranslated (even with Recognize all nodes enabled) while titles and body text translate normally.
- **GitHub:** Header breadcrumbs (usernames, orgs, repo names) and PR author handles stay original while PR titles and discussions translate.
- **X / OpenAI Community / Google Search / Twitch / Llamaperf:** Preserves X “Show more” controls and OpenAI filters; translates Google AI Overviews, Llamaperf benchmark summaries, and Twitch chat messages & sidebar display names (preserving handles, `@` mentions, and emote buttons).

## Step 2: Set per-site preferences {#always-translate-or-leave-a-site-untouched}

Open **Settings → Tools & learning → Website rules → Site preferences** (or toggle directly in the extension popup):

| Preference | Behavior |
| --- | --- |
| **Always translate** | Automatically translates new pages on this site (manually restoring keeps the current page original until you open another article) |
| **Disable extension** | Restores original text and stops all extension features on this domain—**overrides Always translate** |
| **Hide floating ball** | Hides only the floating ball while shortcuts and menus remain active |
| **Translation only** | Hides originals on this site without changing your global display mode; updates existing translations immediately |

::: info Domain matching
Site preferences apply by **main domain** and cover all subdomains, regardless of path or port. Enabling **Auto-translate all sites** continues to respect sites marked as disabled.
:::

## Step 3: Fine-tune content rules & `forceTranslate` {#still-not-matching-the-right-area}

When a site still needs precise DOM targeting, open **Website rules → Content adaptation** and verify precedence in **Applied rules preview** (see [Custom site rules](/en/guide/custom-site-rules)).

### Override `notranslate` wrappers (`forceTranslate`) {#a-section-is-blocked-by-no-translate-markers}

If a website wraps readable text with `translate="no"`, `.notranslate`, or `data-notranslate="true"`, add `forceTranslate` in advanced JSON targeting **the element carrying the marker itself** (already built in for itch.io comments):

```json
{
  "version": 1,
  "rules": [{
    "id": "itch-comments",
    "name": "itch.io comments",
    "match": {"hosts": ["*.itch.io"]},
    "forceTranslate": ["div[id^='game_comments_react_'][id*='_Game-Comments_']"],
    "content": [{"css": [".post_body", ".post_body p", ".post_body li"], "atomic": false}]
  }]
}
```

- `forceTranslate` only overrides the marker on matched elements without modifying webpage DOM attributes; nested editors, code blocks, hidden elements, and `protect` / `exclude` rules remain protected.
- Match each layer if multiple nested containers carry markers; add `allScopes: true` if it should also apply under Recognize all nodes.

Not familiar with CSS selectors? Open an issue on [GitHub Issues](https://github.com/FluentRead/FluentRead/issues) with a public URL, browser version, and redacted screenshot. Full schema reference: [site adaptation reference](https://github.com/FluentRead/FluentRead/blob/main/docs/maintainers/product-reference/site-adaptation-20260906.md).

## Related guides

- [Custom site rules](/en/guide/custom-site-rules)
- [Page & section translation](/en/guide/webpage-translation)
- [Troubleshooting & FAQ](/en/guide/faq)
