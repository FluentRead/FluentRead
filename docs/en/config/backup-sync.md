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

## 3. Cloud backup scope & sensitive data boundary {#cloud-backup-scope-and-sensitive-settings}

Google Drive and WebDAV backups are **always manual** (never auto-uploaded on edits) and stay completely independent of each other.

| Sync scope | Included data | Default |
| --- | --- | --- |
| **Basic settings (v2)** | Languages, appearance, shortcuts, site rules, UI preferences | **Always on** (restoring preserves local keys & connections) |
| **Sensitive settings (v1)** | API keys, credentials, provider/model choices, endpoints, auth headers, custom bodies & private prompts | **Off by default** (requires reading risks & clicking **Agree and enable**) |

::: danger Important encryption notice
Cloud backups are encrypted locally with a **fixed public application passphrase**—anyone who obtains the file can decrypt it. Keep only **Basic settings** enabled for everyday sync; if you opt into Sensitive settings, protect your cloud account and directory permissions carefully and never share the file.
:::

- Cloud backups exclude wordbooks, reading chats, usage statistics, and recent documents; sensitive consent is stored per browser.
- Turning off Sensitive settings does not retroactively scrub older cloud files—perform a Basic save/merge to rewrite the current file and manage provider version history separately.

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
