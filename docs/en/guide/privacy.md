# Privacy policy

Updated: October 3, 2026.

This policy describes how the FluentRead browser extension handles translation content, local records, service credentials, and optional Google Drive, Dropbox and WebDAV configuration backups. FluentRead is a bilingual translation and reading-assistance tool maintained by its open-source project contributors. The website and this policy are publicly accessible without signing in. Translation does not require connecting a Google account.

The feature and service you choose determine which content leaves the browser. FluentRead does not run its own translation server; cloud translation is handled by the selected provider.

## What gets sent?

| Feature | Content and destination |
| --- | --- |
| Page, hover, selection, and input translation | Text and language details to the selected service |
| Free translation | Text sent to enabled providers chosen by background balancing based on success rate, response time, and recent errors; failures may send the text to another candidate |
| Extra AI context | Page title, description, and parts of the article to the AI service; off by default |
| Reading card and learning explanations | Submitted expressions, permitted source context, necessary conversation, and enabled memories used for the response, to the selected AI service |
| Glossaries | Only matched terms and preferred translations, attached to supported AI requests |
| Images and local OCR area capture | Recognition happens locally; recognized text goes to the selected translation service |
| Area capture with model recognition | When enabled and supported by the model, the cropped selection is sent to the selected provider for recognition, followed by text translation; the full screen is not uploaded |
| Documents | Files are parsed locally; text to translate goes to the selected service |
| Video subtitles | Subtitle text goes to the subtitle service. X local AI audio recognition happens on the device |
| Dictionary and read-aloud | Requested words or text go to the corresponding dictionary or voice service |
| WebDAV cloud configuration backup | Connection tests send your username and app password to your chosen server; confirmed operations read or write encrypted configuration without passing through a developer server |
| Google Drive configuration sync (Chrome testing feature) | After explicit confirmation, an encrypted complete configuration backup is saved to your own Google Drive; the scope is described below |

Initial recognition-pack and local-model preparation requires network downloads. Input translation is disabled by default and handles text you deliberately submit from ordinary fields, not password fields.

English word cards include a common-word dictionary. Looking up a word outside it may download and cache a fixed full-dictionary data file of about 3.9 MB from JSDMirror, GitHub Raw, or jsDelivr. That static asset request does not include the word being looked up. Online dictionary providers may still receive the word as described above.

Sites configured for automatic translation can start requests automatically. Choosing a local translation model does not also make dictionaries, read-aloud, downloads, or other tools offline.

## What stays in the browser?

Settings, rules, glossaries, collections, and review records are stored in this browser’s extension storage. Free-translation health, error, and performance statistics are also stored locally for background balancing and cooldown recovery. Service credentials are stored locally by default. When you deliberately use cloud configuration backup, they are also included in the configuration backup described below. Someone with access to the browser profile or backups may still access them.

Regular-window reading-card conversations are retained for 30 days and can be viewed or deleted. Private windows do not read or save this history and do not provide persistent learning collections.

Translation cache defaults to at most 5 MiB or 2,000 entries, with a maximum entry lifetime of 24 hours. You can adjust or clear it. X transcript caching keeps text and timing for up to 32 videos and 7 days, not recognition audio. Clear it in video settings.

The optional full English dictionary is held in the browser's CacheStorage. Clearing browser data or uninstalling the extension removes it.

Document translation and edits stay in the current page. Download files before leaving.

## Google Drive configuration sync

Drive configuration sync is currently being tested in the Chrome extension. Availability depends on the settings page of your installed version. Its purpose is to back up and restore FluentRead settings across your own devices. It does not provide translation or require a persistent connected state.

### When is data accessed, and what is accessed?

Only choosing the Google Drive sync action starts authorization for that operation and reads the backup to prepare a preview. Uploading or applying downloaded settings requires your confirmation of the direction and changes. Opening settings does not automatically access Google Drive.

- **Configuration:** includes API keys, OAuth tokens, authentication headers, custom request bodies, and authentication parameters in URLs. Wordbooks, conversations, and usage statistics are excluded. These OAuth tokens are your configured service credentials; the access token for Google sync is excluded from the backup.
- **Google permissions:** only `drive.appdata`, which manages FluentRead's own hidden application data. The extension does not request access to your other Drive files, Gmail messages, or contacts. See [Google's application-data documentation](https://developers.google.com/workspace/drive/api/guides/appdata).
- **Account information:** the selected account's Drive identifier prevents mixing configurations from different accounts. Email, when returned by Google, identifies the account in the preview and is saved locally with the time after successful sync, as the last synced account. No separate email identity permission is requested, and sync works without an email response.
- **Authorization tokens:** Chrome's identity API manages them for Google API requests. Completion, failure, cancellation, or leaving settings clears the extension's identity cache. Clearing that cache does not revoke the permission in your Google account or delete a backup.

The operation handles the following data. Backup access is limited to FluentRead's own hidden application data folder.

| Data category | Specific content | Purpose |
| --- | --- | --- |
| Configuration backup content | Translation providers and models, languages and appearance, shortcuts, website rules, glossaries, custom prompts, and the service credentials and request parameters listed above | Upload to back up settings; download to preview differences, then restore or merge settings in the direction you confirm |
| Google account information | Drive account identifier and email address when Google returns it | The identifier prevents mixing backups from different accounts; email identifies the current account and the locally saved record of the last successful sync |
| FluentRead backup file information | File ID, name, version, modification time, and available version-check information | Locate the configuration file and check for changes during sync to avoid overwriting newer settings from another device |
| Google access token for this operation | A short-lived authorization token obtained through Chrome's identity API | Authenticate authorized requests to Google; it is not uploaded as configuration or provided to translation services |

Content you enter into prompts, custom request bodies, or URLs is also part of the configuration backup. Sync does not scan webpages or read downloaded documents, learning records, conversations, or usage records as backup content.

### Storage and protection

The backup is sent over HTTPS directly to your own Google Drive hidden application data folder as `fluentread-config.encrypted.json`. It does not pass through a FluentRead developer configuration server or appear as a regular My Drive file. The account identifier, last successfully synced account's email when returned by Google, last-sync time, and an encrypted copy used to compare changes remain in this browser.

The configuration is encrypted on the device before upload using a fixed, publicly available application passphrase. You do not enter a password. **Anyone who obtains the encrypted backup can decrypt it using the public passphrase.** Access protection primarily depends on your Google account, application permissions, and device security. Protect your account, browser profile, and exported backups. Do not attach a backup or complete configuration to a public report.

| Storage location | Content and retention |
| --- | --- |
| Your Google Drive | The encrypted configuration file remains until you delete hidden application data; successful uploads update that file |
| This browser's extension storage | Account identifier, last successfully synced account's email when returned by Google, last-sync time, and an encrypted configuration copy for comparing changes remain until the relevant browser data is cleared or the extension is uninstalled; changing accounts rebuilds the comparison baseline, while cancellation or failure preserves the last successful record |
| Temporary operation state | Account and file information, the confirmation preview, and its encrypted snapshot; previews are valid for 10 minutes, and completion, failure, cancellation, or leaving settings clears pending state and the authorization cache |

### Stop access and delete data

Each sync requires a deliberate action. Stop initiating sync to stop further operations. To revoke permission, select FluentRead in [your Google account's third-party connections](https://myaccount.google.com/connections) and remove access. Sync then requires authorization again.

Choosing **Change Google account** in the preview cancels that preview, clears the extension's identity cache, and starts account authorization again. **Cancel** ends only the current operation. Neither action signs you out of Google in your browser, deletes the cloud backup, or clears the last successful sync record.

The cloud backup remains until you delete it. In Google Drive on the web, use **Settings → Manage apps → FluentRead → Options → Delete hidden app data**. Revoking access, uninstalling the browser extension, or clearing local records does not by itself delete the Drive backup. Deleting the cloud backup does not erase settings already downloaded on other devices.

### Use of Google data

Google account identifiers and configuration backups are used only to check the selected account and synchronize or restore settings. During sync, the account identifier and complete backup are not sent to third parties other than Google. FluentRead does not sell this data or use it for advertising, profiling, or generating content unrelated to sync. Google Workspace API data is not used to develop, improve, or train non-personalized AI or machine-learning models. Developers do not inspect your backup through the sync service. You may voluntarily submit a report after removing credentials and private content. Restored service credentials continue to be used with your selected translation services; the first section explains what those requests send.

FluentRead's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including applicable Limited Use requirements. Google APIs support configuration backup and restoration, not the generation of non-consensual intimate imagery. Google's own handling of cloud storage and account data is also governed by [Google's Privacy Policy](https://policies.google.com/privacy).

## WebDAV cloud configuration backup

WebDAV and Google Drive share the cloud configuration backup entry and preview, confirmation, restore, and merge workflow, with separate records. The extension contacts your chosen WebDAV server only when you test or save a connection or start a backup operation. Opening settings reads a local connection summary; there is no polling or automatic backup.

- **Data and purpose:** your username and app password form the Basic authentication header for the chosen directory. Connection tests and connection saving only perform a read-only `PROPFIND`. Starting sync reads FluentRead’s fixed backup file; directory creation and writing happen only after confirming save or merge.
- **Backup scope:** the same complete configuration as Google Drive, including configured API keys, OAuth tokens, authentication headers, custom request bodies, and authentication parameters in URLs. Wordbooks, chat history, and usage statistics are excluded. The WebDAV connection URL, username, app password, and its authentication header are excluded from configuration backups.
- **Destination and access:** requests go directly to your chosen drive, NAS, or server, without a FluentRead developer server or Google. Its operator and anyone with file access can read the backup. Its logs, retention, and other processing are governed by the service you choose. Requests omit browser cookies and do not forward credentials through redirects.
- **Storage and retention:** the fixed file is `FluentRead/fluentread-config.encrypted.json` under the chosen directory and remains until you delete it. Connection details and the app password are kept in the background’s private encrypted configuration store on this device, are not returned to the form, and are not exported. The successful account, time, and encrypted comparison copy remain until clearing connection settings, related browser data, or uninstalling. Pending snapshots are cleared on completion, failure, cancellation, leaving settings, or expiry.
- **Protection:** upload uses the same fixed public application passphrase as Google Drive; no extra encryption password is required. Anyone obtaining the file can decrypt it with the public passphrase. HTTPS protects transport. HTTP does not protect the username, password, or transferred file and requires explicit acknowledgement. Server account security, directory permissions, and device security provide the main access protection.
- **Stopping and deletion:** stop manual operations to stop new requests. Clear connection settings removes local WebDAV connection details, the app password, and sync records while retaining device configuration and server files. Delete the cloud file separately through your server and revoke its app password to end authorization. Clearing local data, uninstalling, or revoking a password does not delete the server file; deleting that file does not erase configurations already restored elsewhere.

WebDAV data is used only for requested configuration backup, restore, and comparison, not advertising, sale, profiling, or model training. Restored service credentials continue to authenticate your chosen translation services as described above. See the [WebDAV backup guide](./webdav) for setup and server requirements.

## Control and remove other data

Turn off automatic translation, extra AI context, memories, or saving if you do not need them. Restrict the reading card to the current selection to send less context.

Clearing translation cache does not delete learning collections. Manage collections, reading history, and memories in their own pages. Uninstalling or clearing browser data may remove local records.

Backups can include credentials, source sentences, and source information. Check export scope and file contents before sharing. Refer to each cloud provider’s policy for its retention and use of submitted content.

## Dropbox configuration sync

Dropbox is an optional backup destination, available when enabled in the installed build. Opening settings does not access Dropbox. Choosing sync starts authorization and reads the backup for a preview; saving, restoring or merging requires confirmation.

The backup includes configured API keys, OAuth tokens, authentication headers, custom request bodies and URL authentication parameters. It excludes wordbooks, chat history and usage statistics. The Dropbox access token for this operation is excluded.

We request `account_info.read`, `files.metadata.read`, `files.content.read` and `files.content.write`. Account ID and email identify and display the account. File metadata, revision and contents support preview, restore and conditional updates. File access is limited to the FluentRead app folder, not other files, sharing or team data.

The encrypted file `fluentread-config.encrypted.json` is sent over HTTPS directly to your Dropbox Apps / app-name folder, without a developer configuration server. The fixed application passphrase is public in source code: anyone holding the encrypted backup can decrypt it. Protection depends on account, authorization and device security. This folder is visible in Dropbox.

The successful account ID, email, time and encrypted comparison baseline remain in extension storage until it is cleared or the extension is uninstalled, separately from Google Drive. Canceling does not replace a successful record. Pending previews last ten minutes and are cleared on completion, failure, cancellation or leaving settings. Short-lived Dropbox tokens are temporarily held in extension session storage and deleted during cleanup. No refresh token or background polling is used.

Dropbox data is used only for configuration sync, not sold, used for advertising or model training, or sent to translation providers. Restored service credentials are used only for the translation providers you select, as described above.

Canceling ends the operation; changing accounts opens authentication again. Neither logs you out of the Dropbox website or deletes backups. Revoke access in [Dropbox connected apps](https://www.dropbox.com/account/connected_apps), and delete the backup in your Apps folder. Cloud files remain until you delete them; uninstalling or clearing local data does not delete cloud backups or configurations restored on other devices. Dropbox’s own processing is governed by its [privacy policy](https://www.dropbox.com/privacy).

## Website and external links

GitHub Pages hosts the website, which requires no registration or login. Chinese and English content have separate URLs; switching languages is a deliberate choice, and the homepage does not automatically redirect to a different language URL. Website preferences such as appearance are stored in your browser and can be removed by clearing the site's browser data. The website does not read configuration backups or service credentials from the extension. The hosting service's processing of access requests is also governed by [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). When you visit an extension store, Google, or a translation provider's website, that service's own privacy policy also applies.

## Policy updates and contact

The policy is updated as features and data handling change, with the date shown at the top. Changes to the purposes or scope of Google data use will be disclosed, and consent requested before new access or use.

For privacy questions or data-deletion help, contact the project maintainers through [GitHub Issues](https://github.com/FluentRead/FluentRead/issues) or [email](mailto:a1914493943@gmail.com). Remove credentials, account information, and private text from public reports.
