# Data & privacy

The feature and service you choose determine which content leaves the browser. FluentRead does not run its own translation server; cloud translation is handled by the selected provider.

## What gets sent?

| Feature | Content and destination |
| --- | --- |
| Page, hover, selection, and input translation | Text and language details to the selected service |
| Free translation | Text to the configured fallback providers when earlier choices fail |
| Extra AI context | Page title, description, and parts of the article to the AI service; off by default |
| Reading card and learning explanations | Submitted expressions, permitted source context, necessary conversation, and enabled memories used for the response, to the selected AI service |
| Glossaries | Only matched terms and preferred translations, attached to supported AI requests |
| Images and area capture | Recognition happens locally; recognized text goes to the service. Image pixels are not uploaded for text translation |
| Documents | Files are parsed locally; text to translate goes to the selected service |
| Video subtitles | Subtitle text goes to the subtitle service. X local AI audio recognition happens on the device |
| Dictionary and read-aloud | Requested words or text go to the corresponding dictionary or voice service |

Initial recognition-pack and local-model preparation requires network downloads. Input translation is disabled by default and handles text you deliberately submit from ordinary fields, not password fields.

Sites configured for automatic translation can start requests automatically. Choosing a local translation model does not also make dictionaries, read-aloud, downloads, or other tools offline.

## What stays in the browser?

Settings, rules, glossaries, collections, and review records are stored in this browser’s extension storage. Credentials are stored locally for the corresponding services; someone with access to the browser profile or backups may still access them.

Regular-window reading-card conversations are retained for 30 days and can be viewed or deleted. Private windows do not read or save this history and do not provide persistent learning collections.

Translation cache defaults to at most 5 MiB or 2,000 entries, with a maximum entry lifetime of 24 hours. You can adjust or clear it. X transcript caching keeps text and timing for up to 32 videos and 7 days, not recognition audio. Clear it in video settings.

Document translation and edits stay in the current page. Download files before leaving.

## Control and remove data

Turn off automatic translation, extra AI context, memories, or saving if you do not need them. Restrict the reading card to the current selection to send less context.

Clearing translation cache does not delete learning collections. Manage collections, reading history, and memories in their own pages. Uninstalling or clearing browser data may remove local records.

Backups can include credentials, source sentences, and source information. Check export scope and file contents before sharing. Refer to each cloud provider’s policy for its retention and use of submitted content.

Contact the project through [GitHub Issues](https://github.com/FluentRead/FluentRead/issues) or [email](mailto:a1914493943@gmail.com). Remove credentials and private text from reports.
