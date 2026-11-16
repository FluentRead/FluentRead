# Dictionaries and study cards

Open **Selection translation → Dictionaries & study cards** in the extension to manage sources. Add or import a source, then select it in **Dictionary source** above. Without a custom source selected, lookups keep using the existing automatic strategy. Wiktionary is already available as a built-in source.

## Offline dictionaries

Choose **Import offline dictionary** and select the related files together:

| Format | Files to select |
| --- | --- |
| MDict | `.mdx`, optionally with `.mdd`, `.css`, and media files |
| StarDict | `.ifo`, `.idx` or `.idx.gz`, and `.dict` or `.dict.dz` / `.dict.gz` |
| DSL | UTF-8 or BOM-marked UTF-16 `.dsl`; `.dsl.dz` / `.dsl.gz` also work |
| Yomitan | A ZIP containing `index.json` and `term_bank_*.json` |

An import accepts up to 128 MiB of selected files, 256 MiB after expansion, and 500,000 indexed entries. A separate Worker parses and indexes the files. Lookups read matching entries from the selected source only. Canceling stops that Worker and leaves the original files untouched.

MDict supports versions 1.x / 2.x, raw / zlib / LZO blocks, and `Encrypted=2` index obfuscation. Password-protected bodies and DRM are not supported. StarDict binary fields are not converted into definitions. DSL preserves common text tags; complex layouts may be simplified. Expand **Original dictionary layout** to view HTML, styles, and referenced local media. Scripts, forms, external resources, and active content do not run. Large media has a display size limit.

Dictionaries stay in the current browser and are not included in configuration backups or shared recipes. Import them again on another device. Deleting an offline source removes its index and media, while keeping the original files and saved vocabulary.

## JSON APIs and script recipes

Choose **Add source**, enter a name, and use a lookup URL containing `{{word}}`, for example:

```text
https://api.dictionaryapi.dev/api/v2/entries/en/{{word}}
```

Enter these field paths:

```text
Definition: [0].meanings[*].definitions[*].definition
Phonetic: [0].phonetic
Audio: [0].phonetics[0].audio
Example: [0].meanings[*].definitions[*].example
```

Paths support dots, numeric array indexes, `[*]`, and an initial `$`. JSONPath filters that execute expressions are not supported. Empty fields are hidden. Optional authentication headers use JSON and the existing local configuration storage; exported recipes omit them. URLs must use HTTPS, or HTTP on `localhost`, `127.0.0.1`, or `[::1]`. A local dictionary server needs a JSON endpoint with field paths matching its response.

For a **JavaScript** source, the background first requests the declared URL, then passes `word` and the JSON response `data` to the script. The returned JSON uses the same field mapping:

```js
return {
  definition: data[0].meanings.flatMap(m => m.definitions.map(d => d.definition)).join('\n'),
  phonetic: data[0].phonetic || ''
};
```

Set the definition path to `definition` and the phonetic path to `phonetic`. Scripts run with limits inside the bundled QuickJS virtual machine. They cannot read pages, configuration, or files, and have no network or extension APIs. Use the declared request or your own local server for network operations. Unselected recipes do not run. Closing or switching sources prevents old results from replacing the current word.

**Export recipes** includes sources, paths, and scripts, without headers or offline dictionaries. Review URLs and scripts for information you entered before sharing. Importing a recipe with an existing ID keeps the existing configuration.

## Website sources

Choose **Website** and enter a URL containing `{{word}}`. The selection card sends the word to the site only after you choose **Load dictionary website**. The site opens in a sandboxed iframe. Login requirements, embedding restrictions, or same-origin requirements may prevent it from working; use **Open in new tab** if needed.

## Card templates and export

Templates support `{{word}}`, `{{phonetic}}`, `{{definition}}`, `{{example}}`, `{{audio}}`, `{{etymology}}`, `{{inflections}}`, `{{ai_explanation}}`, `{{context_sentence}}`, `{{source}}`, and `{{source_url}}`. Templates render as plain text, with missing fields left empty.

Expand **Preview & export card** in the selection card, check both sides, then export CSV / Markdown or choose **Anki**. `context_sentence` uses a limited sentence near the selected word. `ai_explanation` uses only a completed AI explanation for the current selection and does not make another model request.

Start AnkiConnect locally and enter an existing deck, note type, and front/back field names. The defaults are `Basic` / `Front` / `Back`. Only loopback addresses are accepted. Export does not create decks and rejects duplicates by default. If saving is not confirmed, check Anki before retrying. Review the preview before sharing exports that contain source sentences or personal explanations.

This workspace is available in the browser extension. The userscript keeps its existing online lookup flow. The [learning center](./vocabulary-book.md) remains available separately.
