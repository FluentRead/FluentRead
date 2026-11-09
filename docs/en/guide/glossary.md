# Glossaries

Set consistent translations for names, products, and technical terms in machine and AI translation. To save expressions for learning, use the [Learning center](/en/guide/vocabulary-book).

<GuideVisual kind="glossary" en />

## Common terms on web pages

Web and plain-text translation preserve the original spelling of common technical terms such as `API`, `SDK`, `JSON`, `HTML`, and `ChatGPT` by default. Standalone labels stay in the original text, and terms in sentences carry over into the translation. Matching is case-sensitive across websites and treats names such as `myAPI` as separate identifiers. When glossaries are enabled, matching custom entries take precedence.

## Add your first term

1. Open **Tools & learning → Glossaries** and choose **Add entry**. A glossary is created if needed.
2. Enter the source and translation, then **Save**. Leave the translation blank to preserve the spelling in the source.
3. Enable the master switch and translate. For an already translated page, restore the original first.

You can also add a **Built-in glossary** as an editable copy. Adding it neither enables the master switch nor overwrites your edits. Existing copies do not update automatically when the built-in list changes.

The catalog includes **AI and machine learning, software development, finance and financial reports, academic research, computer hardware, networking and cloud, mathematics**, and **product names kept in the original language**. Domain glossaries apply to English → Simplified Chinese; the product-name glossary applies across languages. Preview these starting translations and adjust them after adding a copy.

To keep a particular word untranslated, add it as an entry and leave its translation blank. For example, enter `FluentRead` as the source with no translation, then enable the master switch. Surrounding text is still translated. Set case sensitivity or a website scope when needed.

Glossary settings save automatically; entry edits require **Save**. Switching glossaries keeps drafts within the current page, but save them before closing it.

## Set the scope

Use **Glossary settings** to change its name, languages, and websites. An empty website scope applies everywhere. Website-specific glossaries do not apply to local documents without a URL. Documents and videos can also select their own glossaries.

Longer overlapping phrases take priority. If several glossaries define the same source term, the earlier one in **Glossary priority** wins. Enable case sensitivity on an entry when spelling case matters.

## Check matches

After saving entries, open **Match preview** and paste source text. Check the matched terms, translations, and counts. If nothing matches, inspect the language, website conditions, and conflict guidance.

Preview runs locally even with the master switch off; actual translation respects that switch. Fixed wording can affect surrounding grammar, so use it for names and stable terms. If a service cannot preserve term markers, retry or switch services.

## Import, export, and backup

Open **Import glossaries**, then choose **Select file** or **Paste text**. Expand **File format** to change CSV, TSV, or JSON. Review the first three entries and import counts; expand **View all entries** for the rest, then choose **Confirm import**. Each method keeps its own draft when you switch. If saving fails, the dialog shows the error and keeps your input for another attempt. Import creates a new glossary without replacing existing ones. Files support UTF-8, BOM-marked UTF-16, and common GB18030 encodings.

Export in **Glossary settings**. JSON retains all settings; CSV and TSV suit spreadsheet editing. Configuration backups also include glossaries.

## How your data is used

Editing and matching run locally. Translation sends protected source text and necessary instructions, not the entire glossary. Surrounding text, permitted page context, and custom request content can still reach your selected service. Term protection does not anonymize the whole request.

## Related guides

- [Translation services](/en/config/translation-engines)
- [Data and privacy](/en/guide/privacy)
