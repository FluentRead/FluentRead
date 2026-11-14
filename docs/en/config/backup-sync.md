# Backup and sync

Save the settings and learning data you need before changing browsers, moving devices, or uninstalling.

<GuideVisual kind="backup" en />

## Choose a method

| What you need | Use |
| --- | --- |
| Move settings, wordbooks, and model usage | Local full backup |
| Undo recent settings changes | Settings history |
| Save and restore settings across your own devices | Google Drive or WebDAV cloud backup |

## Local full backup

1. Open **Settings → Backup and restore → Local backup** and export a backup.
2. Choose whether to include word contexts, then keep the downloaded file.
3. Import it in the other browser, review the data scope and changes, and confirm restoration.

Full backups are unencrypted JSON and can contain API keys, service credentials, saved source text, and source information. Keep them private and do not attach them to public reports. Older configuration JSON and backups remain importable; missing newer settings are filled using compatibility rules.

The **Include vocabulary context** option is off by default. Select it if needed, then choose **Export backup**. **Cancel** and closing the dialog export nothing. Leaving before confirmation cancels that confirmation; file generation already started still finishes downloading. Leaving while an import file is being read requires selecting it again on return. A confirmed restoration continues to completion. The restore preview starts with a short data summary; expand the settings differences when needed.

For learning cards alone, you can also [export to Anki](/en/guide/vocabulary-book#data-and-migration) from the learning center.

## Cloud backup scope and sensitive settings

Cloud backups are manual: changing a setting does not upload it automatically. Google Drive and WebDAV keep separate backups and do not transfer files between them.

| Scope | Contents |
| --- | --- |
| Basic settings, always enabled | Language, appearance, shortcuts, website rules, and other general settings |
| Sensitive settings, off by default | API keys, service credentials, service and model selections, URLs, authentication headers, custom request parameters, and private prompts |

Basic backups exclude the whole sensitive connection configuration and unknown fields. Restoring or merging them preserves this device’s keys, translation services, URLs, and custom connections. Cloud backups exclude wordbooks, chat history, and usage statistics.

To migrate sensitive information, enable **Sensitive settings**, read and acknowledge the risk, then confirm. This choice stays saved in the current browser until you turn it off, including after cancellation, failure, reopening settings, or changing backup methods or accounts. Other devices need their own confirmation. Restoration applies only what the file contains; enabling the option cannot recover keys that were never backed up.

Cloud files are encrypted locally using a fixed public application passphrase. **Anyone obtaining the file can decrypt it.** A compromised account, shared directory, or leaked file can expose API keys. Prefer basic backups; protect your account, directory permissions, and device when migrating credentials.

### Compatibility with older backups and extensions

Current versions read older complete v1 backups; basic scope applies only their general settings. Sensitive backups still use v1. Basic-only backups use v2 and require an updated extension to read. Operations awaiting confirmation before an upgrade need a new preview.

Turning sensitive settings off or restoring basic settings does not remove secrets from an older cloud file. Confirming a basic-settings save or merge removes them from the current file only. Manage retained versions and other copies separately.

## Google Drive configuration sync

Currently supported only in **desktop Google Chrome**. Aside, Ego Lite, Vivaldi (including mobile), and other Chromium-based browsers are not yet supported: installing Chrome extensions does not guarantee Google sign-in support. When browser compatibility cannot be confirmed, the sync button is hidden. Use **WebDAV** or **local backups** instead.

1. Select **Google Drive** under **Cloud backup** and check the scope.
2. Start sync and complete Google authorization.
3. Check the account and choose to save local settings, restore the cloud copy, or merge changes.
4. Review and confirm, then check the last-sync time.

Availability depends on the installed version. Opening settings does not access Drive. Manual operations access only FluentRead’s hidden application data, not regular files, Gmail, or contacts. Google authorization and consent to include sensitive settings are separate. See the [sync privacy details](/en/guide/privacy#google-drive-configuration-sync).

## WebDAV configuration backup

Select **WebDAV** under **Cloud backup**, enter an existing directory’s full URL, username, and app password, then choose **Test and save**. This saves the local connection; start sync, review the preview, and confirm to create a backup.

The connection URL, username, and app password are excluded from cloud backups. See the [WebDAV guide](/en/guide/webdav) for a Nutstore example.

## Delete a cloud backup

Select the provider under **Cloud backup**, then choose **Delete cloud backup**. Check the actual account and WebDAV server address, type **DELETE**, and choose **Delete backup**.

This deletes only that provider’s current configuration file. Local settings, API keys, and connection details remain; the local sync record is cleared. Cancel keeps the file. If it is already absent, choose **Done** to clear old records. Deletion does not require decryption, so older or unreadable backups can also be removed.

Account, connection, or file changes require another confirmation. Without a strong version identifier, WebDAV rechecks file contents; avoid simultaneous operations on several devices. If safe verification is unavailable, follow the provider’s manual deletion instructions.

Manage trash, retained versions, and copies on other devices separately. Revoking access, clearing the connection, or uninstalling does not delete the cloud file. Later sync can create a backup again.

## Recent changes and automatic snapshots

**Settings history → Recent changes** shows setting names, before-and-after values, and time. Open a record to see that change, or compare it with current settings before restoration. The oldest record can only be compared with the current state.

Automatic settings snapshots are kept every six hours. Each list holds up to ten records. They exclude wordbooks, model usage, and API credentials; restoration requires confirmation.

## Cache is different

Cache reuses completed translations. Clearing it keeps learning collections and cannot replace a backup.

## Related guides

- [Collections and learning data](/en/guide/vocabulary-book)
- [Translation statistics](/en/guide/translation-stats)
- [Data and privacy](/en/guide/privacy)
