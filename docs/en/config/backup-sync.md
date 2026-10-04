# Backup & sync

Updated: October 4, 2026.

Save the settings and learning data you need before changing browsers, moving devices, or uninstalling. Full backups, settings history, and cloud configuration sync serve different purposes.

<GuideVisual kind="backup" en />

## Choose a method

| What you need | What to use |
| --- | --- |
| Move settings, vocabulary, and model usage to another browser | Local full backup |
| Undo recent configuration changes | Settings history |
| Sync settings between your own devices | Configuration sync offered by your installed version |

## Cloud backup scope and consent for this operation

Google Drive and WebDAV sync **general settings only by default**, such as language, appearance, shortcuts, and website rules. General backups exclude the entire sensitive connection configuration: API keys, service credentials, authentication headers, service URLs, translation service selections and models, and custom request parameters. Private prompts and unrecognized fields are also excluded. Restoring or merging general settings keeps this device’s keys, translation services, URLs, and custom connections unchanged. Cloud backups exclude wordbooks, chat history, and usage statistics.

To migrate sensitive connections, enable **Include API keys and other sensitive information this time**, read the risks, check the acknowledgement, then choose **Agree, include this time only**. Saving or merging includes this device’s sensitive information. Restoring applies only what the cloud file actually contains; a general-settings backup cannot supply missing keys or replace local connections. Consent applies to this operation only. Completion, failure (including preview preparation failure), cancellation, leaving or reopening settings, or changing the backup method or Google account turns the option off again.

Backups are encrypted on this device using a public application passphrase. **Anyone who obtains the file can still decrypt it.** A compromised third-party account, access to a shared directory, or a leaked backup could expose API keys and other sensitive information. We recommend syncing only general settings. When migrating keys, protect your account and directory permissions and avoid sharing backup files.

### Compatibility with older backups and extensions

- The current extension still reads older complete v1 cloud backups. General-settings mode restores or merges only general settings and preserves this device’s sensitive connections.
- Complete sensitive backups saved with consent for this operation keep the original v1 format, which older extensions can still read. New general-settings backups use v2; older extensions safely reject them and must be upgraded to read them.
- Unconfirmed sync transactions from before the upgrade expire. Generate a new preview and check its scope again.
- Turning the sensitive-information option off or restoring only general settings does not change an existing cloud file. Sensitive information is removed from the current cloud file only after you confirm saving or merging general settings. This does not delete old files or versions retained by the provider; manage those copies separately.

## Local full backup

Open **Settings → Backup & restore**, export a full data backup, and save the file. When importing, review the preview and its scope before restoring.

A full backup can contain API keys, provider credentials, and saved original text. Keep it private. Earlier backups remain importable according to the import preview.

The learning center also offers [Anki export](/en/guide/vocabulary-book#keep-your-collection-safe).

<details class="guide-details">
<summary>Recent changes and automatic snapshots</summary>

## Recent changes and automatic snapshots

**Recent changes** lists setting names, before-and-after values, and precise timestamps. A record initially shows changes from the previous saved version. Choose **Compare with current** to inspect the effect of restoring. The oldest retained record has no previous version to compare.

**Automatic settings snapshots** saves a snapshot every six hours and shows how many settings differ from the current configuration. Each list keeps up to ten records.

Settings history excludes vocabulary, model usage, and API credentials. Restoring requires confirmation.

</details>

<details class="guide-details">
<summary>Google Drive configuration sync</summary>

## Google Drive configuration sync

Google Drive is one of the choices under **Settings → Backup and restore → Cloud configuration backup**. Select it before starting the operation.

Availability depends on the installed version's settings page. General settings are the default scope; including sensitive connections requires consent for this operation as described above.

1. Check this operation’s scope, choose **Sync with Google Drive now**, and authorize Google access for the current operation.
2. Check the account and preview local/cloud differences.
3. Choose a sync direction or merge settings individually.
4. Confirm, then check the result and last-sync time.

Opening settings does not access Drive automatically. The permission covers only FluentRead's hidden app data, not your other files, Gmail, or contacts. Google authorization and consent to include sensitive information are separate steps. Read the [full sync privacy explanation](/en/guide/privacy#google-drive-configuration-sync) for backup protection and deletion.

Cancelling a preview ends that operation. Revoking permission or uninstalling does not delete a cloud backup.

</details>

<details class="guide-details">
<summary>WebDAV configuration backup</summary>

## WebDAV configuration backup

To use your own cloud drive, NAS, or server, select **WebDAV** in **Cloud configuration backup**. Configure a directory URL and app password, test and save the connection, then review and confirm the backup operation.

Like Google Drive, this syncs only general settings by default and includes sensitive connections only with consent for this operation. The WebDAV URL, username, and app password used to access the backup server stay on this device and are excluded from cloud backups. Saving, restoring, and merging are manual operations.

See [the WebDAV guide](/en/guide/webdav) for connection requirements, save and restore steps, file protection, and deletion.

</details>

<details class="guide-details">
<summary>Cache is different</summary>

## Cache is different

Translation cache reuses completed translations. Clearing it does not delete vocabulary and does not replace a full backup.

</details>

## Related guides

- [Learning data](/en/guide/vocabulary-book)
- [Translation statistics](/en/guide/translation-stats)
- [Data and privacy](/en/guide/privacy)
