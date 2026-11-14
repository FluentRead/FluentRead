# Privacy policy

Updated: October 25, 2026.

This policy explains how the FluentRead browser extension handles translation content, local records, service credentials, and optional Google Drive and WebDAV backups. FluentRead is maintained by its open-source contributors. The website and policy require no sign-in, and translation does not require a Google account.

FluentRead does not run its own translation server. The features you enable and providers you choose determine what leaves the browser.

<GuideVisual kind="privacy" en />

## Optional translation privacy

[Translation privacy](/en/config/privacy-protection) can locally mask detected sensitive values before text translation and restore them afterwards, or block matching requests. Custom phrases use local credential storage, and protected requests skip persistent translation caching. Detection is limited and does not replace the separate data-handling rules for features such as the reading assistant or cloud OCR.

## What gets sent?

| Feature | Content and destination |
| --- | --- |
| Page, hover, selection, and input translation | Text and language details to the selected provider |
| Free translation | Text to enabled candidates selected by success rate, response time, and recent errors; failure may send the same text to another candidate |
| Extra AI context | Page title, description, article excerpts, chapter definitions, and completed translations to the AI provider; off by default, with references kept only in current-session memory |
| Reading card and explanations | Submitted expressions, permitted source context, necessary conversation, and enabled memories used for the response, to the selected AI provider |
| Glossaries | Only matched terms and preferred translations attached to supported AI requests, not the full glossary |
| Images and local OCR area capture | Images recognized locally; recognized text to the translation provider |
| Area capture with model recognition | When enabled and supported, the cropped selection goes to the area provider for recognition, followed by text translation; the full screen is not uploaded |
| Documents | Files parsed in the browser; text to translate sent to the chosen provider |
| Video subtitles | Caption text to the subtitle translation provider; X local AI audio recognition runs on the device |
| Dictionary and read-aloud | Requested words or text to the corresponding dictionary or voice provider |
| Google Drive backup | Deliberate operations read or write your hidden application data within the confirmed scope, as explained below |
| WebDAV backup | Connection credentials and backup requests go to your server, as explained below, without a developer server |

Input translation is off by default and processes only deliberately submitted ordinary input, not password fields. Sites configured for automatic translation can start requests automatically. Choosing local translation does not make dictionaries, read-aloud, or resource downloads offline.

OCR language packs and local models need an initial download. Looking up words missing from the included English dictionary may download and cache a fixed full dictionary of about 3.9 MB from JSDMirror, GitHub Raw, or jsDelivr. That static request does not include the queried word. An online dictionary may still receive it.

The first translated PDF export downloads a fixed font of about 5 MB from JSDMirror, an onmicrosoft mirror, jsDelivr, or GitHub Raw, verifies it, and caches it. Failed sources fall back to another source. This retrieves only font data, without sending documents, translations, API keys, or other service credentials.

## What stays in the browser?

| Local data | Storage and removal |
| --- | --- |
| Settings, website rules, glossaries, collections, and review records | This browser’s extension storage; manage them in their respective pages |
| Free-provider health, errors, and performance | Local records for routing, cooldowns, and recovery |
| API keys and service credentials | Local by default for the chosen service; people with access to the browser profile or backups may still read them |
| Reading-card conversations | Regular-window history retained for 30 days and available to view or delete; private windows neither read nor save it and do not provide persistent learning collections |
| Translation cache | Defaults to at most 5 MiB or 2,000 entries, for up to 24 hours; adjustable and clearable |
| English dictionary and PDF font | Verified files in browser CacheStorage for reuse, including offline use; excluded from configuration cloud backup. Clearing browser data or uninstalling may remove them and require a new download |
| X recognition transcripts | Text and timing for at most 32 videos and seven days, without recognition audio; clear in video settings |
| Recent documents | Local IndexedDB stores original files, parsed content, translations, edits, progress, and the translation-settings fingerprint; at most 20 documents and 80 MiB of original files, evicting the least recently updated when full, without time-based expiry |

Delete individual or all recent documents on the document home page. They are excluded from configuration cloud backups. Download files you need to keep. Uninstalling or clearing browser data may remove local records. Clearing translation cache keeps learning collections.

## Cloud backup scope and protection

Google Drive and WebDAV default to **Basic settings**: language, appearance, shortcuts, website rules, and other general settings. This excludes the entire sensitive connection configuration: API keys, configured service OAuth tokens, authentication headers, service URLs, service and model selections, custom request bodies, authentication parameters in URLs, private prompts, and unknown fields. Restoring or merging basic settings preserves local keys, services, URLs, and custom connections.

Subsequent saves or merges include sensitive connections and private prompts only after you enable **Sensitive settings**, read the risk, and acknowledge consent. Restoration applies only what the file contains. The option is off by default. After confirmation, it stays saved in this browser until turned off, including after completion, failure, cancellation, reopening settings, or changing backup methods or accounts. Other devices need their own confirmation.

Cloud backups exclude wordbooks, conversation history, usage statistics, and recent documents, and do not scan webpages for backup content. The current Google sync token and WebDAV connection URL, username, app password, and authentication header are always excluded. Optional backed-up OAuth tokens are credentials you configured for other services.

Uploads are encrypted locally with a fixed public application passphrase, without an extra password. **Anyone obtaining a file can decrypt it using that public passphrase.** It is not protection through a secret only you know. A compromised account, shared directory, or leaked file can expose API keys and other sensitive information. Prefer basic backups. Protect accounts, directories, browser profiles, and devices when moving keys; do not share backup files or complete configurations publicly.

Current versions read complete v1 and basic v2 backups. Sensitive backups retain v1 for older extensions; basic v2 backups need an updated extension. Unconfirmed previews from before an upgrade need regeneration. Turning sensitive settings off, reading, or restoring an older backup does not remove its sensitive contents. Only a confirmed basic-settings save or merge removes them from the current file. Manage older files, provider-retained versions, and other copies separately.

## Google Drive configuration sync

Drive sync is currently being tested in the Chrome extension; availability depends on the installed version. It backs up and restores settings across your own devices without requiring a persistent connection.

### When is data accessed, and what is accessed?

Starting Google Drive sync requests authorization and reads the backup for a preview. Uploading or applying settings requires confirmation of the direction and changes. Opening settings does not access Drive. Google authorization and sensitive-settings consent are separate steps.

| Data | Purpose |
| --- | --- |
| Configuration within the chosen scope; older files may still contain sensitive information | Upload, compare, restore, or merge within the confirmed scope |
| Drive account identifier and email when Google returns it | Prevent mixing accounts, identify the current account, and retain the last successful sync locally; no separate email permission is requested, and sync works without an email response |
| File ID, name, version, modification time, and version-check details | Locate the backup and detect changes before overwriting newer settings |
| Temporary Google token managed by Chrome’s identity API | Authenticate the current Google API requests; never uploaded as configuration or supplied to translation services |

Only `drive.appdata` is requested for FluentRead’s hidden application data, without access to regular Drive files, Gmail, or contacts. See [Google’s documentation](https://developers.google.com/workspace/drive/api/guides/appdata).

### Storage and protection

`fluentread-config.encrypted.json` is sent over HTTPS directly to your Drive hidden application data. It does not appear as a regular My Drive file or pass through a developer configuration server. Encryption limitations are described above.

| Location | Retention |
| --- | --- |
| Your Google Drive | Current configuration file until deletion; successful uploads update it |
| Local extension storage | Account identifier, email when returned, successful sync time, and encrypted comparison copy until successful cloud deletion, relevant browser-data clearing, or uninstalling. Changing accounts rebuilds the comparison baseline; cancellation and failure keep the last successful record |
| Temporary operation state | Account and file details, preview, and encrypted snapshot; previews last ten minutes. Completion, failure, cancellation, or leaving settings clears pending state and identity cache |

Clearing the identity cache neither revokes Google account permission nor deletes the backup.

### Stop access and delete data

Stop initiating sync to stop new operations. To revoke permission, remove FluentRead from [Google third-party connections](https://myaccount.google.com/connections). Future sync needs authorization again.

**Change Google account** cancels the current preview, clears identity cache, and requests authorization again. **Cancel** ends only the current operation. Neither signs you out of Google in the browser, deletes a backup, or removes the last successful record.

Use **Cloud backup → Google Drive → Delete cloud backup**, check the actual account, and confirm. You can also delete hidden app data in Drive under **Settings → Manage apps → FluentRead → Options**. The extension deletes only the confirmed file version with a condition; account or file changes require another check, and cancellation keeps it. Deletion does not need decryption. Success clears local sync records and the comparison copy, keeping local settings and API keys.

Revoking access, uninstalling, or clearing local records does not remove the Drive backup. Manage copies on other devices separately. Later sync may upload a new backup.

### Use of Google data

Account identifiers and backups are used only for account checks, configuration comparison, sync, and restoration. The sync operation does not send account identifiers or complete backups to third parties other than Google. FluentRead does not sell this data or use it for advertising, profiling, or unrelated content generation. Google Workspace API data is not used to develop, improve, or train non-personalized AI or machine-learning models. Developers do not inspect backups through the sync service. Reports are voluntary; remove credentials and private content first. Restored credentials authenticate your chosen providers, whose request scope is described in the first section.

Use of information received from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including applicable Limited Use requirements. Google APIs support backup and restoration, not non-consensual intimate imagery. Google’s processing also follows [Google’s Privacy Policy](https://policies.google.com/privacy).

## WebDAV cloud configuration backup

Only testing or saving a connection or starting a backup operation contacts your chosen server. Opening settings reads a local summary. There is no polling or automatic backup, and records remain separate from Google Drive.

- **Requests and destination:** the username and app password authenticate through Basic headers to your drive, NAS, or server. Connection testing and saving check directories read-only. Starting sync reads the fixed file; directory creation and writing follow confirmation of save or merge. Requests do not pass through a developer server or Google, include browser cookies, or forward passwords through redirects. Server logs and retention follow your provider’s policy. Operators and people with file access can read the backup.
- **Scope and consent:** the basic and sensitive scopes, saved consent, v1/v2 compatibility, and older-file rules above apply. Connection credentials are always excluded from backups and exports and are not returned to the form.
- **Storage and retention:** `FluentRead/fluentread-config.encrypted.json` under the chosen directory remains until deleted. Connection details and passwords stay in the device background’s private encrypted store. Successful account, time, and encrypted comparison copy remain until successful cloud deletion, clearing the connection or related browser data, or uninstalling. Previews last ten minutes, and pending snapshots are cleared on completion, failure, cancellation, leaving, or expiry.
- **Protection:** the public-passphrase limitation above applies; file holders can decrypt the backup. HTTPS protects transport. HTTP leaves the username, password, and file unprotected in transit and requires explicit acknowledgement. Account security, directory permissions, and device security provide the main access protection.
- **Stopping and deletion:** stop manual operations to stop new requests. **Delete cloud backup** displays the account and server, then deletes only the fixed file after confirmation. Local sync records and comparison data are cleared; local settings, API keys, connection details, and other files remain. Without a strong ETag, contents are checked again and deletion uses an available version or existence condition. Avoid simultaneous device operations. A changed version or HTTP 412 stops deletion without weaker retries. If verification is unavailable, delete through the provider. **Clear connection settings** removes only local connection details, app password, and sync records, leaving server files.

Uninstalling or revoking an app password does not delete cloud files. Manage trash, retained versions, and copies on other devices separately. Later sync can recreate a backup. WebDAV data is used only for requested backup, restoration, and comparison, not sale, advertising, profiling, or model training. Restored credentials continue to authenticate selected services. See the [WebDAV guide](/en/guide/webdav).

## Control and remove other data

Disable automatic translation, extra AI context, learning memories, or collection controls you do not need. Restricting reading-card context to the current selection reduces submitted context. Manage collections, reading history, and memories in their respective pages; clearing translation cache keeps them.

Local full backups are unencrypted and can contain keys, source text, and source information. Check scope before export and contents before sharing. Third-party translation services apply their own retention and use policies to submitted requests.

## Website and external links

GitHub Pages hosts the website without registration. Chinese and English have separate URLs and switch only when you choose; the homepage does not redirect languages automatically. Preferences such as appearance stay in the browser and can be removed by clearing this site’s data. The website does not read extension backups or credentials.

Hosting access requests follow [GitHub’s Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Extension stores, Google, and translation-provider websites apply their own policies.

## Policy updates and contact

The policy changes with features and data handling; its date appears above. Changes to Google data purposes or access scope will be disclosed and consent requested before the new access or use.

For privacy questions or deletion help, contact maintainers through [GitHub Issues](https://github.com/FluentRead/FluentRead/issues) or [email](mailto:a1914493943@gmail.com). Remove credentials, account information, and private text from public reports.
