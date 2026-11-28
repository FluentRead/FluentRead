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

## Cloud backup scope, E2EE passphrase, and learning sync

Cloud backups run manually by default, and WebDAV also supports optional scheduled auto-sync. Google Drive and WebDAV keep separate backups and do not transfer files between them.

| Scope | Contents |
| --- | --- |
| Basic settings, always enabled | Language, appearance, shortcuts, website rules, and other general settings |
| Sensitive settings, off by default | API keys, service credentials, service and model selections, URLs, authentication headers, custom request parameters, and private prompts |
| Wordbook, off by default | Saved entries, review schedules, mastery levels, and notes (source contexts have a separate opt-in toggle, off by default) |
| Personal corrections, off by default | Confirmed translation correction rules and project assignments, merged deterministically by identity and latest version |
| Reading materials metadata, off by default | Titles, source URLs, reading progress, topics, and personal notes without large local file blobs |

Basic backups exclude the whole sensitive connection configuration and unknown fields. Restoring or merging them preserves this device’s keys, translation services, URLs, and custom connections. All learning asset toggles are off by default; when enabled, the sync preview shows per-category local/cloud counts and incoming `+N / ~M` diffs before confirmation.

To migrate sensitive information, enable **Sensitive settings**, read and acknowledge the risk, then confirm. This choice stays saved in the current browser until you turn it off, including after cancellation, failure, reopening settings, or changing backup methods or accounts. Other devices need their own confirmation. Restoration applies only what the file contains; enabling the option cannot recover keys that were never backed up.

### End-to-end encryption (E2EE) passphrase

Cloud backups derive an `AES-256-GCM` key locally with `PBKDF2-SHA256` (600,000 iterations) and authenticated additional data (AAD) to prevent downgrade attacks:

- **Legacy compatible mode (default app passphrase)**: Uses the fixed public application passphrase (v1 envelope) for zero-password convenience, though **anyone obtaining the file can decrypt it**.
- **Custom E2EE passphrase (zero-knowledge)**: Protects cloud files with your own passphrase of at least 12 characters (v2 envelope binding `keyMode: "custom"` into AAD). Custom passphrases are never stored in `browser.storage.sync`, config exports, logs, or cloud files. You can keep the passphrase for a single sync, for the current browser session only, or encrypted on this device for scheduled auto-sync, with one-click forget.

> **Important**: Under zero-knowledge encryption, forgetting your custom passphrase means remote backups cannot be recovered. Keep a safe copy of your passphrase.

### Compatibility with older backups and extensions

Current versions seamlessly read legacy-compatible (v1) backups. When you switch to a custom E2EE passphrase, an existing legacy backup is decrypted on read and re-encrypted with your custom passphrase (v2) when you save or merge. If a remote backup is protected with a custom passphrase and none (or the wrong one) is supplied, FluentRead prompts for the passphrase without modifying local data.

Sensitive config snapshots still use payload v1 and basic-only snapshots use v2. Turning sensitive settings off or restoring basic settings does not remove secrets from an older cloud file; confirming a basic-settings save or merge removes them from the current file only. Manage retained versions and other copies separately.

### Optional scheduled auto-sync (WebDAV)

WebDAV supports optional **Scheduled auto-sync** (off by default) with configurable intervals (30 minutes, 1 hour, 6 hours, or 24 hours):

- Performs **safe three-way merges** only: never blindly overwrites local or remote data when there is no common baseline or when conflicts exist. Conflicts pause automatic writes and surface a clear status for manual review.
- Pauses safely without data loss when a custom E2EE passphrase is locked.
- Serializes with manual sync operations, skips cleanly while offline, and retries transient failures with exponential backoff.

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
