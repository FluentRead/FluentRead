# Adjust a particular website

If a website consistently misses text or translates navigation you want kept original, first follow [Website reading area](/en/config/site-adaptation). Everyday automatic-translation and exclusion choices need only site preferences.

For precise areas, open **Settings → Tools & learning → Website rules → Content rules**. The visual editor still requires CSS selectors. If you do not know webpage structure, report the URL and the area you want changed.

<GuideVisual kind="rules" en />

<DocDiagram kind="site-rules-priority" en />

## Start with an existing rule

1. Export a rule backup, then search by website name, domain, or rule ID.
2. Open a rule and customize it, or create a new rule.
3. Use one domain, path, or CSS selector per line. Commas within CSS remain intact.
4. Choose augment to add areas to general recognition, or focus to translate only declared content.
5. Select **Save and apply**, wait for success, then check the actual webpage.

Switching settings categories retains the draft, but closing or refreshing can discard unsaved edits. Save or export first. Failed saves keep the form. Rule IDs are generated automatically and can be changed under advanced options.

A custom rule with the same ID replaces the whole built-in rule. Removing the custom version and saving restores the built-in version while keeping its disabled state. If another settings page updates the rules, your draft cannot silently replace the newer configuration. Export the draft, load the latest rules, and merge your changes.

## Check after saving

Enter a complete HTTP(S) URL in Effective preview to see site preferences, matched rules, and priority. Preview does not visit the website or check its content, permissions, language filters, or service connection.

1. Open the website, restore the original, and translate again.
2. Check titles and article text, plus author names and buttons that should stay original.
3. Scroll, expand comments, or change articles to check later content.
4. If needed, disable the custom rule or restore your backup.

With all-node recognition, only rules that declare support for that scope apply. The advanced field is `allScopes`.

## Official rule updates

Builds that support signed updates periodically check for official rules. Open **Site rules → Content rules** to see the release number or select **Check for rule updates**. Reopen a webpage to use the latest verified release. Custom rules and disabled entries still apply. Offline, the extension uses the last verified release or the rules bundled with a fresh installation.

## Import and backup

Expand **JSON & backup** to import, export, or open the advanced JSON editor. Edits remain a draft until **Save and apply** succeeds.

Import merges by default: matching IDs replace whole rules and other rules remain. Conflicting profile definitions are rejected; rename one before merging. Whole-draft replacement is optional and can be undone before saving.

Basic Google Drive and WebDAV configuration backups include website rules, switches, disabled IDs, custom rules, and profiles. Restoring an older backup without rules keeps the device’s current rules. To migrate missing rules, create a new backup on the original device or import its separately exported rule JSON.

## Detailed examples

The [full rule guide](https://github.com/FluentRead/FluentRead/blob/main/docs/contributing/site-adaptation.md) provides selectors, fields, and validation examples, plus instructions for sharing tested rules with the project.

## Report a compatibility problem

Search results, articles, comments, and signed-in feeds on the same website can use different structures. A dedicated rule does not mean every page type has been verified. Pages without one still use general content recognition. Public-page results also do not establish compatibility behind a login or challenge.

Include the complete URL, browser and extension versions, the area that should be translated, and anything that should stay original. Explain whether scrolling, expanding comments, or changing articles triggers the problem. Do not include credentials or private content. A specific page and action can then be checked through translate, restore, and translate again, including content coverage, duplicate translations, and existing link behavior.

<details class="guide-details">
<summary>Maintainers: inspect the priority website review list</summary>

Run `node scripts/site-translation/audit-site-coverage.cjs` in the repository, adding `--json` for structured output. It reads the current catalog to report declaration counts, categories, fixture evidence, page types to review separately, registered browser contracts, and priority hosts without dedicated rules. Contract registration and host declarations help schedule reviews; they do not establish full URL matching or DOM coverage.

The `scopeAudit`, public HTML probes, and browser records in `coverage.json` retain their historical scope. Historical evidence is not a current live-site pass. Record semantic fixtures, site fixtures, actual pages, and actual translation services separately; rule counts cannot measure the percentage of popular websites that pass.

</details>

## Related guides

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
