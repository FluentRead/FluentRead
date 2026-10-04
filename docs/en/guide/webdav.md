# WebDAV cloud configuration backup

Updated: October 4, 2026.

Google Drive and WebDAV share **Settings → Backup and restore → Cloud configuration backup**. WebDAV stores your configuration on the cloud drive, NAS, or server you choose. Saving, restoring, and merging are manual operations. Each method keeps its own comparison baseline; selecting WebDAV does not transfer a Google Drive backup.

Backups sync only general settings by default. Sensitive connections can be included only with explicit consent for this operation. Wordbooks, chat history, and usage statistics are excluded. The WebDAV URL, username, and app password used to access the backup server always stay on this device and are excluded from backups. This feature requires the browser extension background; use local backup files in the userscript.

<GuideVisual kind="sync" en />

## Scope of this operation

The default scope includes general settings such as language, appearance, shortcuts, and website rules. It excludes the entire sensitive connection configuration: API keys, configured OAuth tokens, authentication information, translation service selections and models, service URLs, custom request bodies, and authentication parameters in URLs. Private prompts and unrecognized fields are also excluded. Restoring or merging general settings keeps this device’s keys, translation services, URLs, and custom connections unchanged.

To migrate sensitive connections, enable **Include API keys and other sensitive information this time**, read the risks, check the acknowledgement, then choose **Agree, include this time only**. Saving or merging includes this device’s sensitive information. Restoring applies only what the cloud backup actually contains; a general-settings backup still preserves this device’s keys and connections. Completion, failure (including preview preparation failure), cancellation, leaving or reopening settings, or switching providers or accounts turns the option off again and requires new consent.

The current extension still reads older complete v1 backups and applies only their general settings by default. Complete sensitive backups saved with consent keep the original v1 format, which older extensions can still read. New general-settings backups use v2; older extensions safely reject them and must be upgraded. Unconfirmed transactions from before the upgrade expire and require a new preview.

Turning the option off or restoring only general settings does not change an older complete backup. Sensitive information is removed from the current cloud file only after you confirm saving or merging general settings. This does not delete old files or versions retained by the provider; manage those copies separately.

## Prepare a connection

The server must support Basic authentication, `PROPFIND`, `GET`, `MKCOL`, and `PUT`. Safe updates also require strong ETags and support for `If-Match` and `If-None-Match`. The extension checks the download response header, the file's [`DAV:getetag` property](https://datatracker.ietf.org/doc/html/rfc4918#section-15.6), then the `HEAD` response header. Property and HEAD lookup are followed by a conditional read and an exact ciphertext check to avoid pairing old content with a new version. Use HTTPS with a valid certificate and a dedicated app password. Property responses are parsed using XML namespaces and the requested resource, including local prefixes, CDATA and character references. Versions from other files or failed properties are never used for replacement.

Enter the **WebDAV URL of an existing directory**, not the website homepage, a sharing link, or the backup file URL. Do not put credentials or query parameters in the URL.

For Nextcloud, a typical URL is:

```text
https://cloud.example.com/remote.php/dav/files/USERNAME/
```

Copy the personal WebDAV URL from Files settings and create an app password under your account’s security settings. See the [official Nextcloud guide](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html). Other services and NAS devices provide their own directory URLs. Your account needs read, directory-creation, and write permission.

For Nutstore, use `https://dav.jianguoyun.com/dav/`, your account email, and a [dedicated app password](https://help.jianguoyun.com/?p=2064). You do not need to create the `FluentRead` folder in advance. The first sync checks for a backup and only creates the folder and file after you confirm saving. A 409 caused by a missing backup parent directory is treated as a first backup only after the entry directory is verified; invalid entry URLs and permission errors still stop the operation.

## Save your first backup

1. Select **WebDAV → Set up WebDAV** in cloud configuration backup.
2. Enter the directory URL, username, and app password. HTTP requires acknowledging unencrypted transport; prefer HTTPS.
3. Choose **Test connection**. This only checks directory access, changes no cloud files, and does not prove write permission.
4. Choose **Test and save** to store the connection on this device. This still creates no cloud backup.
5. Check this operation’s scope and choose **Sync with WebDAV now**. If no backup exists, review saving this device’s configuration, with general settings only by default, and confirm.

The file is stored under your chosen directory at:

```text
FluentRead/fluentread-config.encrypted.json
```

Previews expire after 10 minutes. **Cancel** or leaving settings ends the preview without deleting an existing backup. There is no automatic background sync or persistent connected state.

## Restore or merge on another device

Configure the same directory and account on the other device. Read the backup, choose **Restore cloud configuration** or **Save device configuration**, then continue to review and confirm.

General-settings mode restores or merges only general settings, preserving this device’s keys, translation services, URLs, and custom connections. Saving replaces the current cloud file within this operation’s scope. With consent to include sensitive information, saving or merging can include all sensitive connections; restoring still depends on the backup’s actual content. If both sides contain changes you want to keep, use the secondary **Review and merge** action and resolve conflicts. In sensitive-information mode, credentials, services, models, and custom connections are masked and selected as a group.

Before committing, the extension rechecks both configurations. A change on either side requires a fresh preview. Updates use ETag conditions to reject stale writes. A successful operation records the account and time locally.

The current account, server URL, and last backup time for that connection appear beside the sync button. Use **Edit connection** to change accounts or servers. The confirmation screen lists changed settings and their device and cloud values. Connection changes show categories while keys, addresses, and custom content stay hidden. Merge conflicts appear before automatically retained changes. Identical configuration only updates the local sync record without uploading again.

If none of these methods provides a strong ETag, the preview still shows differences and lets you **Restore cloud configuration**. A notice explains that saving and merging are unavailable. You go directly to review and confirmation, without unavailable save or merge actions or an extra operation-selection step. Restoration still rechecks cloud content and never bypasses authentication, corrupt-file checks, or version conflicts.

<details class="guide-details">
<summary>Change accounts or delete data</summary>

## Change accounts or delete data

Use **Edit connection** to change the server, account, or password. Changing the URL or username requires entering the password again. Old previews and baselines cannot apply to a new connection. Saved passwords are not returned to the form.

**Clear connection settings** removes this device’s WebDAV connection, app password, and sync record, while keeping device configuration and cloud files. Delete the backup file using your server or drive interface. Revoke an app password with the service to stop its authorization. Uninstalling the extension does not delete server files.

</details>

<details class="guide-details">
<summary>Protection and troubleshooting</summary>

## Protection and troubleshooting

Backups use AES-GCM encryption before upload with the same fixed public application passphrase as Google Drive. No additional encryption password is required. **Anyone who obtains the file can decrypt it using the public passphrase.** A compromised third-party account, access to a shared directory, or a leaked backup could expose API keys and other sensitive information in that backup. Protection primarily depends on the server account, directory permissions, HTTPS, and device security. We recommend syncing only general settings. When migrating keys, protect your account and directory permissions and avoid sharing backup files. See the [privacy policy](./privacy).

| Message | What to check |
| --- | --- |
| Incorrect username or password | Account, app password, and Basic authentication support |
| Missing or invalid WebDAV directory | The full directory URL and whether WebDAV is enabled |
| Cannot connect | Network, certificate, and final URL; credentials are never forwarded through redirects |
| Backup can be restored but lacks a version for safe replacement | Review differences and restore in the preview; saving and merging are unavailable until the server provides strong ETags and conditional writes |
| Cloud backup changed | Generate a new preview and check other devices’ changes |
| Storage full or backup too large | Free server space or use a local backup; JSON is limited to 20 MiB and encrypted files to 32 MiB |

See [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918) for the WebDAV protocol. Server permissions, certificates, and conditional-write behavior vary. After connection testing, perform a real save and restore to confirm compatibility with your service.

</details>
