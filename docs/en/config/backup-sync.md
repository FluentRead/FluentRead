# Backup & sync

Save the settings and learning data you need before changing browsers, moving devices, or uninstalling. Full backups, settings history, and cloud configuration sync serve different purposes.

## Choose a method

| What you need | What to use |
| --- | --- |
| Move settings, vocabulary, and model usage to another browser | Local full backup |
| Undo recent configuration changes | Settings history |
| Sync settings between your own devices | Configuration sync offered by your installed version |

## Local full backup

Open **Settings → Backup & restore**, export a full data backup, and save the file. When importing, review the preview and its scope before restoring.

A full backup can contain API keys, provider credentials, and saved original text. Keep it private. Earlier backups remain importable according to the import preview.

The learning center also offers [Anki export](/en/guide/vocabulary-book#keep-your-collection-safe).

## Recent changes and automatic snapshots

**Recent changes** lists setting names, before-and-after values, and precise timestamps. A record initially shows changes from the previous saved version. Choose **Compare with current** to inspect the effect of restoring. The oldest retained record has no previous version to compare.

**Automatic settings snapshots** saves a snapshot every six hours and shows how many settings differ from the current configuration. Each list keeps up to ten records.

Settings history excludes vocabulary, model usage, and API credentials. Restoring requires confirmation.

## Google Drive configuration sync

Google Drive is one of the choices under **Settings → Backup and restore → Cloud configuration backup**. Select it before starting the operation.

Availability depends on the installed version's settings page. Sync covers configuration, excluding vocabulary, chat records, and usage statistics.

1. Choose **Sync with Google Drive now** and authorize the current operation.
2. Check the account and preview local/cloud differences.
3. Choose a sync direction or merge settings individually.
4. Confirm, then check the result and last-sync time.

Opening settings does not access Drive automatically. The permission covers only FluentRead's hidden app data, not your other files, Gmail, or contacts. Configuration includes provider credentials; read the [full sync privacy explanation](/en/guide/privacy#google-drive-configuration-sync) for backup protection and deletion.

Cancelling a preview ends that operation. Revoking permission or uninstalling does not delete a cloud backup.

## Dropbox configuration sync

Select **Dropbox** under **Cloud configuration backup** in a build that enables this provider. Start sync, check the account, choose save, restore, or merge, then confirm. Opening settings does not authorize Dropbox. Canceling or finishing clears the temporary session; use **Change Dropbox account** in the preview if needed.

Only FluentRead's App folder is accessed. Backup contents match Google Drive, while account records and comparison baselines stay separate. See the [illustrated maintainer setup guide (Chinese)](/config/dropbox-sync) and [privacy policy](/en/guide/privacy#dropbox-configuration-sync).

## WebDAV configuration backup

To use your own cloud drive, NAS, or server, select **WebDAV** in **Cloud configuration backup**. Configure a directory URL and app password, test and save the connection, then review and confirm the backup operation.

Like Google Drive, this backs up configuration and provider credentials, not wordbooks, chat history, or usage statistics. WebDAV connection credentials stay on the current device. Saving, restoring, and merging are manual operations.

See [the WebDAV guide](/en/guide/webdav) for connection requirements, save and restore steps, file protection, and deletion.

## Cache is different

Translation cache reuses completed translations. Clearing it does not delete vocabulary and does not replace a full backup.

## Next steps

- [Learning data](/en/guide/vocabulary-book)
- [Translation statistics](/en/guide/translation-stats)
- [Data and privacy](/en/guide/privacy)

