# Privacy policy

Updated: October 4, 2026.

This policy describes how the FluentRead browser extension handles translation content, local records, service credentials, and optional Google Drive / WebDAV cloud configuration backups. FluentRead is a bilingual translation and reading-assistance tool maintained by its open-source project contributors. The website and this policy are publicly accessible without signing in. Translation does not require connecting a Google account.

The feature and service you choose determine which content leaves the browser. FluentRead does not run its own translation server; cloud translation is handled by the selected provider.

<GuideVisual kind="privacy" en />

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
| Google Drive configuration sync (Chrome testing feature) | After confirmation, an encrypted backup within this operation’s scope is saved to your own Google Drive; general settings are the default, and sensitive information requires separate consent for this operation |

Initial recognition-pack and local-model preparation requires network downloads. Input translation is disabled by default and handles text you deliberately submit from ordinary fields, not password fields.

English word cards include a common-word dictionary. Looking up a word outside it may download and cache a fixed full-dictionary data file of about 3.9 MB from JSDMirror, GitHub Raw, or jsDelivr. That static asset request does not include the word being looked up. Online dictionary providers may still receive the word as described above.

Sites configured for automatic translation can start requests automatically. Choosing a local translation model does not also make dictionaries, read-aloud, downloads, or other tools offline.

## What stays in the browser?

Settings, rules, glossaries, collections, and review records are stored in this browser’s extension storage. Free-translation health, error, and performance statistics are also stored locally for background balancing and cooldown recovery. Service credentials are stored locally by default. Cloud backups exclude them by default; they are included in saving or merging only after explicit consent for that operation. Older cloud backups may still contain credentials, and turning the option off does not delete them. Someone with access to the browser profile or backups may still access them.

Regular-window reading-card conversations are retained for 30 days and can be viewed or deleted. Private windows do not read or save this history and do not provide persistent learning collections.

Translation cache defaults to at most 5 MiB or 2,000 entries, with a maximum entry lifetime of 24 hours. You can adjust or clear it. X transcript caching keeps text and timing for up to 32 videos and 7 days, not recognition audio. Clear it in video settings.

The optional full English dictionary is held in the browser's CacheStorage. Clearing browser data or uninstalling the extension removes it.

Document translation and edits stay in the current page. Download files before leaving.

## Google Drive configuration sync

Drive configuration sync is currently being tested in the Chrome extension. Availability depends on the settings page of your installed version. Its purpose is to back up and restore FluentRead settings across your own devices. It does not provide translation or require a persistent connected state.

### When is data accessed, and what is accessed?

Only choosing the Google Drive sync action starts authorization for that operation and reads the backup to prepare a preview. Uploading or applying downloaded settings requires your confirmation of the direction and changes. Opening settings does not automatically access Google Drive.

- **Default configuration scope:** only general settings, such as language, appearance, shortcuts, and website rules. The entire sensitive connection configuration is excluded: API keys, service OAuth tokens, authentication headers, service URLs, translation service selections and models, custom request bodies, and authentication parameters in URLs. Private prompts and unrecognized fields are also excluded. Restoring or merging general settings preserves this device’s keys, translation services, URLs, and custom connections.
- **Consent for sensitive information:** enable “Include API keys and other sensitive information this time”, read the risks, and check the acknowledgement before all sensitive connections and private prompts can be included in saving or merging for this operation. Restoring applies only what the backup actually contains; a general-settings backup does not replace this device’s sensitive connections. Wordbooks, chat history, and usage statistics are excluded. The access token for Google sync is never backed up; optional OAuth tokens refer to your configured service credentials.
- **Google permissions:** only `drive.appdata`, which manages FluentRead's own hidden application data. The extension does not request access to your other Drive files, Gmail messages, or contacts. See [Google's application-data documentation](https://developers.google.com/workspace/drive/api/guides/appdata).
- **Account information:** the selected account's Drive identifier prevents mixing configurations from different accounts. Email, when returned by Google, identifies the account in the preview and is saved locally with the time after successful sync, as the last synced account. No separate email identity permission is requested, and sync works without an email response.
- **Authorization tokens:** Chrome's identity API manages them for Google API requests. Completion, failure, cancellation, or leaving settings clears the extension's identity cache. Clearing that cache does not revoke the permission in your Google account or delete a backup.

Google authorization and consent to include sensitive information are separate steps. The sensitive-information option is off by default, and consent applies only to this operation. Completion, failure (including preview preparation failure), cancellation, leaving or reopening settings, or switching providers or Google accounts turns it off again.

The current extension still reads older complete v1 backups. General-settings mode applies only their general settings and keeps this device’s connections. Complete sensitive backups saved with consent keep v1, which older extensions can still read. New general-settings backups use v2; older extensions safely reject them and must be upgraded. Unconfirmed transactions from before the upgrade expire and require a new preview.

Reading or restoring an older backup does not remove its sensitive information. Sensitive information is removed from the current cloud file only after you confirm saving or merging general settings. Turning the option off does not delete old files or versions retained by the provider; manage historical copies separately.

The operation handles the following data. Backup access is limited to FluentRead's own hidden application data folder.

| Data category | Specific content | Purpose |
| --- | --- | --- |
| Configuration backup content | General settings by default; explicit consent for this operation can add all sensitive connections, service credentials, request parameters, and private prompts. Older files being read may still contain sensitive information | Upload settings within this operation’s scope; download to preview differences, then restore or merge within the scope and direction you confirm |
| Google account information | Drive account identifier and email address when Google returns it | The identifier prevents mixing backups from different accounts; email identifies the current account and the locally saved record of the last successful sync |
| FluentRead backup file information | File ID, name, version, modification time, and available version-check information | Locate the configuration file and check for changes during sync to avoid overwriting newer settings from another device |
| Google access token for this operation | A short-lived authorization token obtained through Chrome's identity API | Authenticate authorized requests to Google; it is not uploaded as configuration or provided to translation services |

Content you enter into private prompts, custom request bodies, or service URLs participates in saving or merging only after explicit consent to include sensitive information for this operation. Sync does not scan webpages or read downloaded documents, learning records, conversations, or usage records as backup content.

### Storage and protection

The backup is sent over HTTPS directly to your own Google Drive hidden application data folder as `fluentread-config.encrypted.json`. It does not pass through a FluentRead developer configuration server or appear as a regular My Drive file. The account identifier, last successfully synced account's email when returned by Google, last-sync time, and an encrypted copy used to compare changes remain in this browser.

The configuration is encrypted on the device before upload using a fixed, publicly available application passphrase. You do not enter a password. **Anyone who obtains the encrypted backup can decrypt it using the public passphrase.** Access protection primarily depends on your Google account, application permissions, and device security. If a third-party account is compromised, someone accesses a shared directory, or a backup leaks, API keys and other sensitive information in that backup could be exposed. We recommend syncing only general settings. When migrating keys, protect your account, directory permissions, browser profile, and exported backups, and avoid sharing files. Do not attach a backup or complete configuration to a public report.

| Storage location | Content and retention |
| --- | --- |
| Your Google Drive | The encrypted configuration file remains until you delete hidden application data; successful uploads update that file |
| This browser's extension storage | Account identifier, last successfully synced account's email when returned by Google, last-sync time, and an encrypted configuration copy for comparing changes remain until the relevant browser data is cleared or the extension is uninstalled; changing accounts rebuilds the comparison baseline, while cancellation or failure preserves the last successful record |
| Temporary operation state | Account and file information, the confirmation preview, and its encrypted snapshot; previews are valid for 10 minutes, and completion, failure, cancellation, or leaving settings clears pending state and the authorization cache |

### Stop access and delete data

Each sync requires a deliberate action. Stop initiating sync to stop further operations. To revoke permission, select FluentRead in [your Google account's third-party connections](https://myaccount.google.com/connections) and remove access. Sync then requires authorization again.

Choosing **Change Google account** in the preview cancels that preview, clears the extension's identity cache, and starts account authorization again. **Cancel** ends only the current operation. Neither action signs you out of Google in your browser, deletes the cloud backup, or clears the last successful sync record.

The cloud backup remains until you delete it. In the extension, use **Cloud configuration backup → Google Drive → Delete cloud backup**, check the actual account and confirm. You can also use **Settings → Manage apps → FluentRead → Options → Delete hidden app data** in Google Drive. The extension conditionally deletes only the confirmed file version; canceling keeps it, and account or version changes require another check. Deletion does not decrypt the contents. Successful deletion clears this provider’s local sync record and encrypted comparison baseline while keeping local settings and API keys. Revoking access, uninstalling or clearing local records does not automatically delete the cloud file. Manage other-device copies separately; later sync can upload a backup again.

### Use of Google data

Google account identifiers and configuration backups are used only to check the selected account and synchronize or restore settings. During sync, the account identifier and complete backup are not sent to third parties other than Google. FluentRead does not sell this data or use it for advertising, profiling, or generating content unrelated to sync. Google Workspace API data is not used to develop, improve, or train non-personalized AI or machine-learning models. Developers do not inspect your backup through the sync service. You may voluntarily submit a report after removing credentials and private content. Restored service credentials continue to be used with your selected translation services; the first section explains what those requests send.

FluentRead's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including applicable Limited Use requirements. Google APIs support configuration backup and restoration, not the generation of non-consensual intimate imagery. Google's own handling of cloud storage and account data is also governed by [Google's Privacy Policy](https://policies.google.com/privacy).

## WebDAV cloud configuration backup

WebDAV and Google Drive share the cloud configuration backup entry and preview, confirmation, restore, and merge workflow, with separate records. The extension contacts your chosen WebDAV server only when you test or save a connection or start a backup operation. Opening settings reads a local connection summary; there is no polling or automatic backup.

- **Data and purpose:** your username and app password form the Basic authentication header for the chosen directory. Connection tests and connection saving only perform a read-only `PROPFIND`. Starting sync reads FluentRead’s fixed backup file; directory creation and writing happen only after confirming save or merge.
- **Backup scope:** as with Google Drive, only general settings by default, excluding the entire sensitive connection configuration, private prompts, and unrecognized fields. Restoring or merging general settings keeps this device’s connections. Saving or merging can include all sensitive connections only with explicit consent for this operation; restoring applies only what the backup actually contains. Wordbooks, chat history, and usage statistics are excluded. The WebDAV URL, username, app password, and authentication header used to access the backup server are always excluded from configuration backups.
- **Destination and access:** requests go directly to your chosen drive, NAS, or server, without a FluentRead developer server or Google. Its operator and anyone with file access can read the backup. Its logs, retention, and other processing are governed by the service you choose. Requests omit browser cookies and do not forward credentials through redirects.
- **Storage and retention:** the fixed file is `FluentRead/fluentread-config.encrypted.json` under the chosen directory and remains until you delete it. Connection details and the app password are kept in the background’s private encrypted configuration store on this device, are not returned to the form, and are not exported. The successful account, time, and encrypted comparison copy remain until successful cloud deletion, clearing connection settings, related browser data, or uninstalling. Pending snapshots are cleared on completion, failure, cancellation, leaving settings, or expiry.
- **Protection:** upload uses the same fixed public application passphrase as Google Drive; no extra encryption password is required. Anyone obtaining the file can decrypt it with the public passphrase. A compromised third-party account, access to a shared directory, or a leaked backup could expose API keys and other sensitive information in that backup. HTTPS protects transport. HTTP does not protect the username, password, or transferred file and requires explicit acknowledgement. Server account security, directory permissions, and device security provide the main access protection.
- **Stopping and deletion:** stop manual operations to stop new requests. Delete cloud backup shows the actual account and server, then conditionally deletes only the fixed backup file after confirmation. It clears local sync records and the comparison baseline while keeping local settings, API keys, connection details and other files in the directory. If safe version information is unavailable, delete the file in your provider interface. Manage trash, retained versions and other-device copies separately. Later manual sync can create a new backup. Clear connection settings removes only local connection details, the app password and sync records. Uninstalling or revoking a password does not automatically delete the server file.

WebDAV follows the same consent reset, v1/v2 compatibility, and older-file rules as Google Drive. Turning the option off or restoring general settings does not clear old backups. Confirming save or merge of general settings updates only the current file and cannot delete versions retained by the provider. WebDAV data is used only for requested configuration backup, restore, and comparison, not advertising, sale, profiling, or model training. Restored service credentials continue to authenticate your chosen translation services as described above. See the [WebDAV backup guide](./webdav) for setup and server requirements.

## Control and remove other data

Turn off automatic translation, extra AI context, memories, or saving if you do not need them. Restrict the reading card to the current selection to send less context.

Clearing translation cache does not delete learning collections. Manage collections, reading history, and memories in their own pages. Uninstalling or clearing browser data may remove local records.

Backups can include credentials, source sentences, and source information. Check export scope and file contents before sharing. Refer to each cloud provider’s policy for its retention and use of submitted content.

## Website and external links

GitHub Pages hosts the website, which requires no registration or login. Chinese and English content have separate URLs; switching languages is a deliberate choice, and the homepage does not automatically redirect to a different language URL. Website preferences such as appearance are stored in your browser and can be removed by clearing the site's browser data. The website does not read configuration backups or service credentials from the extension. The hosting service's processing of access requests is also governed by [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). When you visit an extension store, Google, or a translation provider's website, that service's own privacy policy also applies.

## Policy updates and contact

The policy is updated as features and data handling change, with the date shown at the top. Changes to the purposes or scope of Google data use will be disclosed, and consent requested before new access or use.

For privacy questions or data-deletion help, contact the project maintainers through [GitHub Issues](https://github.com/FluentRead/FluentRead/issues) or [email](mailto:a1914493943@gmail.com). Remove credentials, account information, and private text from public reports.
