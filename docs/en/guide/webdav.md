# WebDAV cloud configuration backup

Use your own cloud storage to save FluentRead settings and restore them in another browser or device. This example uses **Nutstore**, also known as Jianguoyun. Backups run only when you start an operation; changing settings does not upload them automatically.

<GuideVisual kind="webdav" en />

## Create a Nutstore app password

1. Sign in to the [Nutstore website](https://www.jianguoyun.com/).
2. Open **Account information → Security options → Third-party application management** from your account menu.
3. Add an app password, name it `FluentRead`, then generate and copy it.

Use this app password rather than your Nutstore sign-in password. See [Nutstore’s official instructions](https://help.jianguoyun.com/?p=2064).

## Prepare a connection

Open **Settings → Backup and restore → Cloud backup**, select **WebDAV**, then **Set up WebDAV**.

| Field | Nutstore value |
| --- | --- |
| WebDAV directory URL | `https://dav.jianguoyun.com/dav/` |
| Backup subdirectory | Keep the default `FluentRead/` to use the existing backup location |
| Username | Your Nutstore account email, such as `yourname@example.com` |
| App password | The app password generated above |

Copy the full URL rather than a homepage, sharing link, or file URL. Do not append `FluentRead/` or create that folder in advance. See the [official connection parameters](https://help.jianguoyun.com/?p=5677).

Choose **Test connection**, then **Test and save**. Neither uploads a backup. Testing checks directory access and does not prove write permission. The saved connection stays on this device.

## Koofr

Use `https://app.koofr.net/dav/Koofr/` with your Koofr account email and an app password generated for FluentRead. The `/dav/` directory lists mounts and cannot store a backup directly. A new connection using the default or blank backup path selects your personal Koofr directory. For an existing connection that cannot write, enter the full directory URL above and test it again. [Koofr's connection instructions](https://koofr.eu/help/koofr_with_webdav/how-do-i-connect-a-service-to-koofr-through-webdav/)

## Synology NAS and custom directories

Enable WebDAV Server on your NAS and grant the account read and write access to the shared folder. Enter the final WebDAV directory URL, such as `https://nas.example.com:5006/shared-folder/`, using your configured port and reverse-proxy path. Do not use the DSM sign-in page or a sharing link.

- The **WebDAV directory URL** can include a shared folder and existing subdirectories. This directory must already exist. If the service root does not allow folder creation, enter a shared-folder URL that the account can access.
- **Backup subdirectory** defaults to `FluentRead/`. You can enter a nested path such as `Backups/FluentRead`. Its folders are created within the directory above only after you confirm the first save.
- If the URL already points to the final backup directory, **leave the backup subdirectory blank**. FluentRead saves `fluentread-config.encrypted.json` directly there, without appending `FluentRead/` or attempting to create the service root or shared folder.

For example, the URL `https://nas.example.com:5006/shared-folder/backups/` with a blank subdirectory stores the file at `https://nas.example.com:5006/shared-folder/backups/fluentread-config.encrypted.json`. Use the same URL and backup subdirectory on other devices.

Changing the subdirectory invalidates old previews and does not move or delete the previous backup. Existing connections without this setting continue to use `FluentRead/`.

## Save your first backup

1. Check the scope: **Basic settings** are always enabled; **Sensitive settings** are off by default.
2. To migrate API keys, service and model choices, or private prompts, enable sensitive settings, read and acknowledge the risk, and confirm. This choice stays enabled until you turn it off.
3. Choose **Sync with WebDAV now**, check the account, scope, and preview, then **Save to cloud**.
4. After completion, check the account, server URL, and last-sync time.

With the default subdirectory, confirming the first save creates:

```text
FluentRead/fluentread-config.encrypted.json
```

Later saves update this file. If a backup already exists, choose restoration, saving, or merging deliberately so that a new device does not overwrite it.

The backup is encrypted locally without a separate backup password, using a fixed public application passphrase. **Anyone obtaining the file can decrypt it.** Protect your account, directory permissions, and device. Do not share the file. The Nutstore app password authenticates storage access; it is not the encryption password.

## Restore or merge on another device

1. Install FluentRead on the new device, preferably updating both devices first.
2. Enter the same WebDAV directory URL, backup subdirectory, and account. You can generate a separate app password for this device. Choose **Test and save**; connection credentials are not migrated in backups.
3. To restore backed-up keys, enable sensitive settings on this device and acknowledge the risk.
4. Start sync, choose **Restore cloud configuration → Continue**, review the changes, then **Restore to device**.

If both sides are identical, choose **Finish sync**. Choose **Save device configuration** to update the cloud copy, or **Merge individually** to keep changes from both sides and resolve conflicts before **Confirm and sync**.

Basic-scope restoration or merging preserves local keys and connections. Enabling sensitive settings cannot recover keys missing from the backup. Cloud backups exclude wordbooks, conversations, and usage statistics; use a [local full backup](/en/config/backup-sync#local-full-backup) for learning data.

Previews last ten minutes. Cancel or leave settings to end a preview. Local or cloud changes require a new one. Operate devices one at a time to avoid overwriting the backup.

## Protection and troubleshooting

| Problem | What to check |
| --- | --- |
| Incorrect username or password | Use your account email and app password; regenerate a revoked password and update the connection |
| Missing or invalid directory | For Nutstore, check `https://dav.jianguoyun.com/dav/`. For a NAS, enter an existing shared directory with account access, not a homepage or sharing link |
| Test passed but no file appeared | Start sync, review, and confirm a save |
| Keys or translation services are missing | Check whether the file contains sensitive settings and whether they are enabled on this device |
| Cloud backup changed | Check other devices and generate a new preview |
| Connection failure or too many requests | Check the URL and network, wait, and avoid repeatedly testing |
| Full storage or oversized file | Free space or use local backup; configuration JSON is limited to 20 MiB and encrypted files to 32 MiB |

Nutstore’s access limits follow its [official policy](https://help.jianguoyun.com/?p=2064).

## Change accounts or delete data

**Edit connection** changes the URL, username, or password. With the same URL and username, leave the password blank to retain it. Changing either requires entering the password again and invalidates the old preview.

**Clear connection settings** removes only this device’s connection, app password, and sync records. Local settings and cloud files remain. Revoke the app password in Nutstore’s third-party application settings to remove access.

**Delete cloud backup** asks you to check the account and server, type **DELETE**, and confirm. It deletes only the fixed backup file, keeps local settings, API keys, connection details, and other directory files, and clears local sync records. Cancel keeps the file; if it is already absent, finish the operation.

Manage trash, retained versions, and other-device copies separately. Uninstalling, revoking the password, or clearing the connection does not delete server files. Later sync can create a backup again.

<details class="guide-details">
<summary>Backup scope and other servers</summary>

## Scope of this operation

Basic backups exclude sensitive connections, private prompts, and unknown fields. Sensitive-settings consent persists in this browser through cancellation, failure, and account changes until turned off. Restoration still applies only the file’s actual contents. Turning the option off or restoring basic settings does not remove sensitive data from an older file. A confirmed basic-settings save or merge updates only the current file, not retained versions.

New basic backups use v2 and need an updated extension to read; complete sensitive backups retain v1. See the [privacy policy](/en/guide/privacy#webdav-cloud-configuration-backup).

## Other WebDAV services

For another cloud drive or NAS, use its existing-directory URL. The account needs Basic authentication and permission to read, create directories, and write; deletion also needs `DELETE`. A common [Nextcloud](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html) URL is `https://cloud.example.com/remote.php/dav/files/your-username/`.

Prefer HTTPS with a valid certificate and an app password. HTTP leaves the username, password, and file unprotected in transit and requires acknowledgement. Do not include credentials or query parameters in the URL. Requests do not forward passwords through redirects; use the final directory URL. After testing, perform a real save and restore to confirm compatibility.

## Cloud version protection

Strong ETags support conditional writes. Without them, FluentRead checks file content and uses an available server version or an existence condition, then reads back a saved file to verify it. Detected changes stop the operation. Content checking cannot fully prevent concurrent writes; do not operate several devices at once. If deletion cannot be safely verified, remove the fixed file through your provider’s interface.

</details>
