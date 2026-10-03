# WebDAV cloud configuration backup

Google Drive and WebDAV share **Settings → Backup and restore → Cloud configuration backup**. WebDAV stores your configuration on the cloud drive, NAS, or server you choose. Saving, restoring, and merging are manual operations. Each method keeps its own comparison baseline; selecting WebDAV does not transfer a Google Drive backup.

Backups include API keys, configured OAuth tokens, authentication headers, custom request bodies, and authentication parameters in URLs. Wordbooks, chat history, and usage statistics are excluded. The WebDAV URL, username, and app password stay on this device and are excluded from backups. This feature requires the browser extension background; use local backup files in the userscript.

## Prepare a connection

The server must support Basic authentication, `PROPFIND`, `GET`, `MKCOL`, and `PUT`. Safe updates also require strong ETags and support for `If-Match` and `If-None-Match`. Use HTTPS with a valid certificate and a dedicated app password.

Enter the **WebDAV URL of an existing directory**, not the website homepage, a sharing link, or the backup file URL. Do not put credentials or query parameters in the URL.

For Nextcloud, a typical URL is:

```text
https://cloud.example.com/remote.php/dav/files/USERNAME/
```

Copy the personal WebDAV URL from Files settings and create an app password under your account’s security settings. See the [official Nextcloud guide](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html). Other services and NAS devices provide their own directory URLs. Your account needs read, directory-creation, and write permission.

## Save your first backup

1. Select **WebDAV → Set up WebDAV** in cloud configuration backup.
2. Enter the directory URL, username, and app password. HTTP requires acknowledging unencrypted transport; prefer HTTPS.
3. Choose **Test connection**. This only checks directory access, changes no cloud files, and does not prove write permission.
4. Choose **Test and save** to store the connection on this device. This still creates no cloud backup.
5. Choose **Sync with WebDAV now**. If no backup exists, review saving this device’s configuration and confirm.

The file is stored under your chosen directory at:

```text
FluentRead/fluentread-config.encrypted.json
```

Previews expire after 10 minutes. **Cancel** or leaving settings ends the preview without deleting an existing backup. There is no automatic background sync or persistent connected state.

## Restore or merge on another device

Configure the same directory and account on the other device. Read the backup, choose **Restore cloud configuration** or **Save device configuration**, then continue to review and confirm.

Restoring replaces this device’s settings and credentials. Saving replaces the cloud configuration. If both sides contain changes you want to keep, use the secondary **Review and merge** action and resolve conflicts. Credentials and custom connections are masked and selected as a group.

Before committing, the extension rechecks both configurations. A change on either side requires a fresh preview. Updates use ETag conditions to reject stale writes. A successful operation records the account and time locally.

## Change accounts or delete data

Use **Edit connection** to change the server, account, or password. Changing the URL or username requires entering the password again. Old previews and baselines cannot apply to a new connection. Saved passwords are not returned to the form.

**Clear connection settings** removes this device’s WebDAV connection, app password, and sync record, while keeping device configuration and cloud files. Delete the backup file using your server or drive interface. Revoke an app password with the service to stop its authorization. Uninstalling the extension does not delete server files.

## Protection and troubleshooting

Backups use AES-GCM encryption before upload with the same fixed public application passphrase as Google Drive. No additional encryption password is required. **Anyone who obtains the file can decrypt it using the public passphrase.** Protect the server account, directory permissions, HTTPS connection, and device. Do not publicly share backup files. See the [privacy policy](./privacy).

| Message | What to check |
| --- | --- |
| Incorrect username or password | Account, app password, and Basic authentication support |
| Missing or invalid WebDAV directory | The full directory URL and whether WebDAV is enabled |
| Cannot connect | Network, certificate, and final URL; credentials are never forwarded through redirects |
| Missing ETag for safe updates | Existing backups can still be restored; saving needs strong ETags and conditional writes |
| Cloud backup changed | Generate a new preview and check other devices’ changes |
| Storage full or backup too large | Free server space or use a local backup; JSON is limited to 20 MiB and encrypted files to 32 MiB |

See [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918) for the WebDAV protocol. Server permissions, certificates, and conditional-write behavior vary. After connection testing, perform a real save and restore to confirm compatibility with your service.
