# Backup & sync

Protect your settings, API credentials, and learning data before switching browsers, moving devices, or reinstalling—with clear boundaries between local files, automatic snapshots, and optional cloud sync.

<GuideVisual kind="backup" en />

<DocDiagram kind="backup-sync-compare" en />

## 1. Local full backup (Recommended for migration) {#local-full-backup}

Best for migrating all settings, vocabulary, and model usage together:

1. Open **Settings → Backup & restore → Local backup** and click **Export backup**.
2. Optionally check **Include word context** (off by default) and save the JSON file.
3. On the destination browser, import the file, review the scope summary and diffs, and confirm restore.

::: warning Keep full backup files private
Local full backups are **unencrypted JSON** and may contain API keys, credentials, saved sentences, and source URLs. Never attach them to public bug reports. Legacy backups remain importable.
:::

For Anki flashcards alone, see [Export to Anki](/en/guide/vocabulary-book#data-and-migration).

## 2. Settings history & 6-hour automatic snapshots {#recent-changes-and-automatic-snapshots}

Undo accidental configuration tweaks instantly without needing a backup file:

- **Settings history → Recent changes:** Lists changed keys, before/after values, timestamps, and a **Compare with current** preview.
- **Automatic snapshots:** Captured every **6 hours** (up to **10 entries** each). Excludes vocabulary, usage stats, and API credentials.

## 3. Cloud backup scope, E2EE passphrase & learning sync {#cloud-backup-scope-and-sensitive-settings}

Google Drive and WebDAV backups are **manual by default** (WebDAV also supports optional scheduled auto-sync) and stay completely independent of each other.

| Sync scope | Included data | Default |
| --- | --- | --- |
| **Basic settings (v2)** | Languages, appearance, shortcuts, site rules, UI preferences | **Always on** (restoring preserves local keys & connections) |
| **Sensitive settings (v1)** | API keys, credentials, provider/model choices, endpoints, auth headers, custom bodies & private prompts | **Off by default** (requires reading risks & clicking **Agree and enable**) |
| **Wordbook** | Saved entries, review schedules, mastery levels, and notes (source contexts have a separate opt-in toggle, off by default) | **Off by default** (confirmed in sync preview) |
| **Personal corrections** | Confirmed translation correction rules and project assignments, merged deterministically by identity and latest version | **Off by default** (confirmed in sync preview) |
| **Reading materials metadata** | Titles, source URLs, reading progress, topics, and personal notes without large local file blobs | **Off by default** (confirmed in sync preview) |

All learning asset toggles are off by default; when enabled, the sync preview shows per-category local/cloud counts and incoming `+N / ~M` diffs before confirmation.

### End-to-end encryption (E2EE) passphrase

Cloud backups derive an `AES-256-GCM` key locally with `PBKDF2-SHA256` (600,000 iterations) and authenticated additional data (AAD) to prevent downgrade attacks:

- **Legacy compatible mode (default app passphrase):** Uses the fixed public application passphrase (v1 envelope) for zero-password convenience, though **anyone obtaining the file can decrypt it**.
- **Custom E2EE passphrase (zero-knowledge):** Protects cloud files with your own passphrase of at least 12 characters (v2 envelope binding `keyMode: "custom"` into AAD). Custom passphrases are never stored in `browser.storage.sync`, config exports, logs, or cloud files. You can keep the passphrase for a single sync, for the current browser session only, or saved on this device in the extension's background local storage (for scheduled WebDAV auto-sync), with one-click forget.
  - **Device retention boundary:** When "Keep on this device" is selected, the passphrase is stored in the extension's background local encrypted IndexedDB using the same at-rest protection boundary as `local:credentials` — protecting against `browser.storage.sync`, config exports, logs, and web page / content-script access. However, anyone with full access to your local browser profile could still reach local extension storage; choose per-sync or session-only retention for maximum isolation.

::: danger Zero-knowledge & encryption notice
- In legacy compatible mode, files use a **fixed public application passphrase**—anyone who obtains the file can decrypt it. Enable a **custom E2EE passphrase** when syncing sensitive settings.
- Under zero-knowledge encryption, forgetting your custom passphrase means remote backups cannot be recovered. Keep a safe copy of your passphrase.
:::

- Cloud backups exclude reading chats, usage statistics, and recent documents; sensitive and learning toggles are stored per browser.
- Turning off Sensitive settings does not retroactively scrub older cloud files—perform a Basic save/merge to rewrite the current file and manage provider version history separately.
- Current versions seamlessly read legacy-compatible (v1) backups: when you switch to a custom E2EE passphrase, an existing legacy backup is decrypted on read and re-encrypted with your custom passphrase (v2) when you save or merge. If a remote backup requires a custom passphrase and none (or the wrong one) is supplied, FluentRead prompts without modifying local data.

### Optional scheduled auto-sync (WebDAV)

WebDAV supports optional **Scheduled auto-sync** (off by default) with configurable intervals (30 minutes, 1 hour, 6 hours, or 24 hours):

- Performs **safe three-way merges** only: never blindly overwrites local or remote data when there is no common baseline or when conflicts exist. Conflicts pause automatic writes and surface a clear status for manual review.
- Pauses safely without data loss when a custom E2EE passphrase is locked.
- Serializes with manual sync operations, skips cleanly while offline, and retries transient failures with exponential backoff.

## 4. Google Drive configuration sync {#google-drive-configuration-sync}

Currently available on **desktop Google Chrome only** (other Chromium browsers should use **WebDAV** or **Local backup**):

1. Select **Google Drive** under **Cloud backup** and confirm sync scope.
2. Click **Sync with Google Drive now** and authorize (`drive.appdata` hidden app-data scope only—never accesses regular Drive files, Gmail, or contacts).
3. Verify the account, choose **Save local**, **Restore cloud**, or **Merge item by item**, review diffs, and confirm.

See [Privacy policy · Google Drive sync](/en/guide/privacy#google-drive-configuration-sync) for full permissions and retention details.

## 5. WebDAV cloud backup {#webdav-cloud-backup}

Works with Nutstore, Koofr, Synology NAS, Nextcloud, and standard WebDAV servers. Enter directory URL, username, and app password, click **Test and save** (connection credentials never enter cloud backups), then run a manual sync and confirm upload.

Step-by-step setup: [WebDAV cloud backup guide](/en/guide/webdav).

## 6. Deleting a cloud backup {#delete-a-cloud-backup}

Choose your cloud service under **Cloud backup**, click **Delete cloud backup**, verify the account/server URL, type the confirmation phrase, and confirm:

- Removes only the remote backup file and local sync record while **keeping local settings, API keys, and connection details**.
- Revoking access, clearing a connection, or uninstalling does not delete cloud files; check your cloud provider’s trash/version history separately.

## Cache vs. backup {#how-cache-differs-from-backup}

The **translation cache** only speeds up repeated passages; clearing it never deletes vocabulary and cannot replace backups.

## Related guides

- [WebDAV cloud backup guide](/en/guide/webdav)
- [Learning center data & migration](/en/guide/vocabulary-book#data-and-migration)
- [Privacy policy](/en/guide/privacy)
